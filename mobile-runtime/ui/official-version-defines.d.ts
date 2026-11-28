// 构建期注入的官方版本 define（official-version.mjs 从本机官方安装包实挖，
// bundle.mjs / bundle-ui.mjs 经 esbuild define 注入）。官方版本号会随上游更新漂，
// 所以这里只声明形状不写值；兜底常量在 server-compat.ts（CI/无官方安装的机器）。
// 本文件是全局脚本（无 import/export），声明对整个 program 生效——上游 shared/version.ts
// 里的同名 declare 是模块内的，不覆盖端侧文件。
declare const __ZCODE_VERSION__: string;
declare const __ZCODE_AI_SDK_ANTHROPIC_VERSION__: string;
declare const __ZCODE_AI_SDK_PROVIDER_UTILS_VERSION__: string;
