import { PROTOCOL_V4_LIMITS, type AttachmentRef } from "@zcode/shared/zcode-protocol-v4";
import * as vfs from "../compat/vfs.mjs";

/** 附件按会话存入应用私有目录；引用不含用户文件路径，跨会话不可读取。 */
export function createMobileAttachments() {
  type Upload = {
    sessionId: string; uploadId: string; fileName: string; mime: string;
    totalBytes: number; totalChunks: number; checksum: string; chunks: Uint8Array[];
    receivedBytes: number; createdAt: number;
  };
  const uploads = new Map<string, Upload>();
  const root = "/work/.zcode/mobile-attachments";
  const safeId = (value: string) => {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) throw new Error("附件标识无效");
    return value;
  };
  const key = (sessionId: string, uploadId: string) => `${safeId(sessionId)}:${safeId(uploadId)}`;
  const file = (sessionId: string, uploadId: string) => `${root}/${safeId(sessionId)}/${safeId(uploadId)}`;
  const refFor = (sessionId: string, uploadId: string) => `mobile-attachment:${safeId(sessionId)}:${safeId(uploadId)}`;
  const uploadIdFromRef = (sessionId: string, ref: string) => {
    const prefix = `mobile-attachment:${safeId(sessionId)}:`;
    if (!ref.startsWith(prefix)) throw new Error("附件不属于当前会话");
    return safeId(ref.slice(prefix.length));
  };
  const bytesToBase64 = (bytes: Uint8Array) => {
    let binary = "";
    for (let i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    return btoa(binary);
  };
  const fromBase64 = (value: string) => {
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new Error("附件 base64 无效");
    const raw = atob(value);
    return Uint8Array.from(raw, (ch) => ch.charCodeAt(0));
  };
  const supported = (mime: string) =>
    /^image\/(?:png|jpeg|gif|webp)$/i.test(mime) ||
    /^text\//i.test(mime) || /^(?:application\/json|application\/pdf)$/i.test(mime);
  const assertSupported = (mime: string) => {
    if (!supported(mime)) throw new Error(`端侧暂不支持此附件类型：${mime}`);
  };

  return {
    begin(params: { sessionId: string; uploadId: string; fileName: string; mime: string; totalBytes: number; totalChunks: number; checksum: string }) {
      const id = key(params.sessionId, params.uploadId);
      assertSupported(params.mime);
      if (!params.fileName || params.fileName.length > 255 || /[\0\r\n]/.test(params.fileName) ||
          !Number.isInteger(params.totalBytes) || params.totalBytes < 0 || params.totalBytes > PROTOCOL_V4_LIMITS.attachmentMaxBytes ||
          !Number.isInteger(params.totalChunks) || params.totalChunks < 0 || params.totalChunks > PROTOCOL_V4_LIMITS.attachmentUploadMaxChunks ||
          (params.totalBytes === 0) !== (params.totalChunks === 0) || !/^sha256:[0-9a-f]{64}$/.test(params.checksum)) {
        throw new Error("附件上传参数无效");
      }
      const now = Date.now();
      for (const [k, upload] of uploads) {
        if (now - upload.createdAt > PROTOCOL_V4_LIMITS.attachmentUploadTtlMs) uploads.delete(k);
      }
      const existing = uploads.get(id);
      if (existing) {
        if (existing.checksum !== params.checksum || existing.totalBytes !== params.totalBytes ||
            existing.totalChunks !== params.totalChunks || existing.mime !== params.mime || existing.fileName !== params.fileName) {
          throw new Error("附件上传标识已被其他事务使用");
        }
        return { uploadId: params.uploadId, state: "staging" as const, nextChunkIndex: existing.chunks.length };
      }
      const metadataPath = `${file(params.sessionId, params.uploadId)}.json`;
      if (vfs.existsSync(metadataPath)) {
        const saved = JSON.parse(String(vfs.readFileSync(metadataPath, "utf8"))) as { fileName?: string; mime?: string; bytes?: number; checksum?: string };
        if (saved.fileName !== params.fileName || saved.mime !== params.mime || saved.bytes !== params.totalBytes || saved.checksum !== params.checksum) {
          throw new Error("已提交的附件标识不可覆盖");
        }
        return { uploadId: params.uploadId, state: "committed" as const, nextChunkIndex: params.totalChunks, ref: refFor(params.sessionId, params.uploadId) };
      }
      if (uploads.size >= PROTOCOL_V4_LIMITS.attachmentUploadMaxConcurrent ||
          [...uploads.values()].reduce((sum, u) => sum + u.totalBytes, 0) + params.totalBytes > PROTOCOL_V4_LIMITS.attachmentUploadMaxStagedBytes) {
        throw new Error("附件上传任务过多");
      }
      uploads.set(id, { ...params, chunks: [], receivedBytes: 0, createdAt: now });
      return { uploadId: params.uploadId, state: "staging" as const, nextChunkIndex: 0 };
    },
    chunk(params: { sessionId: string; uploadId: string; chunkIndex: number; dataBase64: string }) {
      const upload = uploads.get(key(params.sessionId, params.uploadId));
      if (!upload || params.chunkIndex !== upload.chunks.length || params.chunkIndex >= upload.totalChunks) throw new Error("附件分块顺序无效");
      if (Date.now() - upload.createdAt > PROTOCOL_V4_LIMITS.attachmentUploadTtlMs) {
        uploads.delete(key(params.sessionId, params.uploadId));
        throw new Error("附件上传已过期");
      }
      const bytes = fromBase64(params.dataBase64);
      if (bytes.length > PROTOCOL_V4_LIMITS.attachmentChunkMaxBytes || upload.receivedBytes + bytes.length > upload.totalBytes) throw new Error("附件分块超限");
      upload.chunks.push(bytes);
      upload.receivedBytes += bytes.length;
      return { uploadId: params.uploadId, nextChunkIndex: upload.chunks.length };
    },
    async commit(params: { sessionId: string; uploadId: string }) {
      const id = key(params.sessionId, params.uploadId);
      const upload = uploads.get(id);
      if (!upload || upload.chunks.length !== upload.totalChunks || upload.receivedBytes !== upload.totalBytes) throw new Error("附件上传不完整");
      if (Date.now() - upload.createdAt > PROTOCOL_V4_LIMITS.attachmentUploadTtlMs) {
        uploads.delete(id);
        throw new Error("附件上传已过期");
      }
      const bytes = new Uint8Array(upload.totalBytes);
      let offset = 0;
      for (const chunk of upload.chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      const digest = await crypto.subtle.digest("SHA-256", bytes.buffer);
      const checksum = "sha256:" + [...new Uint8Array(digest)].map((n) => n.toString(16).padStart(2, "0")).join("");
      if (checksum !== upload.checksum) throw new Error("附件校验失败");
      const path = file(params.sessionId, params.uploadId);
      vfs.mkdir(`${root}/${safeId(params.sessionId)}`, { recursive: true });
      vfs.writeFile(`${path}.bin`, bytes);
      vfs.writeFile(`${path}.json`, JSON.stringify({ fileName: upload.fileName, mime: upload.mime, bytes: bytes.length, checksum }));
      uploads.delete(id);
      return { ref: refFor(params.sessionId, params.uploadId) };
    },
    abort(params: { sessionId: string; uploadId: string }) { uploads.delete(key(params.sessionId, params.uploadId)); },
    resolve(sessionId: string, ref: AttachmentRef) {
      const id = uploadIdFromRef(sessionId, ref.ref);
      const path = file(sessionId, id);
      const meta = JSON.parse(String(vfs.readFileSync(`${path}.json`, "utf8"))) as { fileName: string; mime: string; bytes: number };
      assertSupported(meta.mime);
      if (meta.fileName !== ref.fileName || meta.mime !== ref.mime || meta.bytes !== ref.bytes) throw new Error("附件引用与已提交内容不一致");
      const bytes = new Uint8Array(vfs.readFileSync(`${path}.bin`));
      if (bytes.length !== meta.bytes) throw new Error("附件内容不完整");
      return { ...meta, dataBase64: bytesToBase64(bytes) };
    },
    read(sessionId: string, ref: AttachmentRef, offset: number, limit: number) {
      if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > PROTOCOL_V4_LIMITS.attachmentChunkMaxBytes) throw new Error("附件读取范围无效");
      const result = this.resolve(sessionId, ref);
      const bytes = fromBase64(result.dataBase64);
      const end = Math.min(offset + limit, bytes.length);
      if (offset > bytes.length) throw new Error("附件读取越界");
      return { dataBase64: bytesToBase64(bytes.subarray(offset, end)), mediaType: result.mime, totalBytes: bytes.length, nextOffset: end < bytes.length ? end : null };
    },
  };
}
