import type { ISettingService } from "@zcode/services";
import * as vfs from "../compat/vfs.mjs";
import { getZCodeDataRootDir } from "@zcode/services/deep/paths.js";
import { loadCoreFromAsset } from "./tool-engine.js";

export function createMobileMemoryContext(settings: ISettingService) {
  return async (workspacePath: string) => {
    if (!(await settings.get()).memoryEnabled) return null;
    const core = await loadCoreFromAsset() as unknown as {
      resolveProjectMemoryRoot(input: {cliStorageRoot:string;workspacePath:string}):string;
      buildMemorySection(root:string):{content:string};
      formatProjectMemoryIndexContent(text:string):string;
    } | null;
    if (!core) throw new Error("记忆运行时未加载");
    const root=core.resolveProjectMemoryRoot({cliStorageRoot:`${getZCodeDataRootDir()}/cli`,workspacePath});
    vfs.mkdir(root,{recursive:true},"mkdir");
    const index=`${root}/MEMORY.md`;
    const content=vfs.existsSync(index)?core.formatProjectMemoryIndexContent(String(vfs.readFileSync(index,"utf8"))):"";
    return {root,content:[core.buildMemorySection(root).content,content?`Contents of ${index}:\n${content}`:""].join("\n\n")};
  };
}
