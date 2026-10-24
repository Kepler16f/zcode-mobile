package cn.zcode.mobile

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import android.webkit.JavascriptInterface
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.security.KeyStore
import javax.crypto.BadPaddingException
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * 端侧凭据层（§8 M6）：登录换来的 token 存在哪、谁来加密。
 *
 * 上游桌面版（services/src/credential/credentialService.ts）用 node:crypto 的 AES-256-GCM，
 * 密钥来自 `ZCODE_CREDENTIAL_SECRET`，没有就退回 `sha256("zcode-credential-fallback:" + platform
 * + homedir + username)`。那个退路在端侧等于把密钥和密文放在一起，装了就能读，所以不搬它——
 * 这里的密钥由 **AndroidKeyStore** 生成且不可导出（`nonExportable`），密文只在本机、本 app uid
 * 下能解开。桌面垫片刻意不提供 createCipheriv（compat/shims/crypto.mjs:11），就是为了让这条路
 * 只能走原生桥。
 *
 * 形状与 FsBridge 一致：单入口 `call(JSON)`、同步返回。`ICredentialService` 只有
 * load/save/delete 三个方法（credential/credential.ts:11），JS 侧把它包成 Promise 就行，
 * 但同步通道让"读凭据"不会被 WebView 的 JS 线程调度拖成异步竞态。
 *
 * 落点在 `noBackupFilesDir`：这份目录既不进 Auto-Backup，也不进设备到设备的迁移，
 * 凭据不会因为备份被带到别的设备上。
 */
class CredentialBridge(private val context: Context) {

    @JavascriptInterface
    fun name(): String = ENGINE

    /** 能力清单用：屏上写的"登录已接入 / 凭据引擎"要来自真话。 */
    @JavascriptInterface
    fun engine(): String = ENGINE

    /**
     * 同步入口。request 形如 {"op":"load"|"save"|"remove","key":"oauth:zai:access_token","value":"..."}。
     * 返回 {"ok":true,...} 或 {"ok":false,"code":"...","error":"..."}。
     */
    @JavascriptInterface
    fun call(request: String): String {
        val req = try {
            JSONObject(request)
        } catch (e: Exception) {
            return fail("bad_request", "请求不是 JSON: ${e.message}")
        }
        val key = req.optString("key")
        if (key.isBlank()) return fail("bad_request", "缺少 key")
        return try {
            when (req.optString("op")) {
                "load" -> load(key)
                "save" -> save(key, req.getString("value"))
                "remove" -> remove(key)
                else -> fail("bad_request", "未知 op: ${req.optString("op")}")
            }
        } catch (e: Exception) {
            // Keystore 侧的异常种类很杂（KeyPermanentlyInvalidatedException、ProviderException…），
            // 一律如实报出来：静默当成"没有凭据"会让用户明明登录过却被判未登录，且再也查不到原因。
            fail("bridge_error", "${e.javaClass.simpleName}: ${e.message}")
        }
    }

    private fun load(key: String): String {
        val file = fileFor(key)
        if (!file.exists()) return JSONObject().put("ok", true).put("value", JSONObject.NULL).toString()
        val stored = try {
            Base64.decode(file.readText().trim(), Base64.NO_WRAP)
        } catch (e: Exception) {
            return fail(DECRYPT_FAILED, "凭据文件损坏：${e.message}")
        }
        if (stored.size <= IV_BYTES) return fail(DECRYPT_FAILED, "凭据文件长度不足")
        return try {
            val cipher = cipher(Cipher.DECRYPT_MODE, key, stored.copyOfRange(0, IV_BYTES))
            val plain = cipher.doFinal(stored.copyOfRange(IV_BYTES, stored.size))
            JSONObject().put("ok", true).put("value", String(plain, Charsets.UTF_8)).toString()
        } catch (e: BadPaddingException) {
            // AEAD tag 不对 = 要么文件被改过，要么 Keystore 密钥已经换掉（卸载重装/恢复出厂之外的场景）。
            // 交给上层按"凭据解密失败"清理会话，措辞要和 shared/src/oauth.ts:16 的前缀一致。
            fail(DECRYPT_FAILED, "凭据解密失败：$key 的 AEAD 校验没通过")
        }
    }

    private fun save(key: String, value: String): String {
        val cipher = cipher(Cipher.ENCRYPT_MODE, key, null)
        val payload = cipher.doFinal(value.toByteArray(Charsets.UTF_8))
        val bytes = cipher.iv + payload
        val dir = storeDir()
        if (!dir.exists() && !dir.mkdirs()) return fail("bridge_error", "凭据目录建不出来")
        val target = fileFor(key)
        val temp = File(dir, "${target.name}.tmp")
        FileOutputStream(temp).use { it.write(Base64.encode(bytes, Base64.NO_WRAP)) }
        if (!temp.renameTo(target)) {
            temp.delete()
            return fail("bridge_error", "凭据写入没落上")
        }
        return ok(JSONObject().put("bytes", bytes.size))
    }

    private fun remove(key: String): String =
        ok(JSONObject().put("removed", fileFor(key).delete()))

    private fun cipher(mode: Int, key: String, iv: ByteArray?): Cipher {
        val instance = Cipher.getInstance(TRANSFORMATION)
        val secret = secretKey()
        if (mode == Cipher.ENCRYPT_MODE) {
            instance.init(mode, secret)
        } else {
            instance.init(mode, secret, GCMParameterSpec(TAG_BITS, iv))
        }
        // AAD 绑住"这段密文属于哪个凭据名"：把 access_token 的密文挪到 refresh_token 名下会直接解不开。
        instance.updateAAD(key.toByteArray(Charsets.UTF_8))
        return instance
    }

    // @JavascriptInterface 的方法跑在 WebView 自己的线程池上，可能并发；首次登录会连着写好几个
    // key，两个线程同时发现"密钥还不存在"就会各生成一把，先写的那批凭据从此解不开。
    @Synchronized
    private fun secretKey(): SecretKey {
        val ks = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
        (ks.getEntry(ALIAS, null) as? KeyStore.SecretKeyEntry)?.let { return it.secretKey }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE)
        generator.init(
            KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                // 不要求用户认证：否则每次取凭据都要解锁屏幕，后台的 token 刷新会直接卡死。
                .setUserAuthenticationRequired(false)
                // IV 每次随机（GCM 的 nonce 复用是致命的），所以加密只能由 Keystore 自己出 IV。
                .setRandomizedEncryptionRequired(true)
                .build(),
        )
        return generator.generateKey()
    }

    private fun storeDir(): File = File(context.noBackupFilesDir, "credentials")

    private fun fileFor(key: String): File {
        // 凭据名带冒号（oauth:zai:access_token），不能直接当文件名；用固定长度的散列，
        // 顺手把"文件名里不含账号语义"这件事也做掉。
        val digest = java.security.MessageDigest.getInstance("SHA-256").digest(key.toByteArray(Charsets.UTF_8))
        return File(storeDir(), digest.joinToString("") { "%02x".format(it) })
    }

    private fun ok(data: JSONObject): String = data.put("ok", true).toString()

    private fun fail(code: String, error: String): String =
        JSONObject().put("ok", false).put("code", code).put("error", error).toString()

    private companion object {
        const val ENGINE = "android-keystore-aes-gcm"
        const val ANDROID_KEYSTORE = "AndroidKeyStore"
        const val ALIAS = "zcode.credential.masterkey"
        const val TRANSFORMATION = "AES/GCM/NoPadding"
        const val IV_BYTES = 12
        const val TAG_BITS = 128
        const val DECRYPT_FAILED = "decrypt_failed"
    }
}
