import { useEffect, useState } from "react";
import { useOptionalPlatform } from "./usePlatform.js";

/** 布局是宿主能力+触屏设置的投影，开合状态仍由现有sidePaneState拥有。 */
export function usePortraitSideDrawer(): boolean {
  const platform = useOptionalPlatform();
  const read = () =>
    Boolean(
      platform?.supportsPortraitSideDrawer &&
      typeof document !== "undefined" &&
      document.documentElement.classList.contains("zcode-narrow") &&
      innerHeight >= innerWidth,
    );
  const [portrait, setPortrait] = useState(read);
  useEffect(() => {
    const update = () => setPortrait(read());
    update();
    window.addEventListener("resize", update);
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => {
      window.removeEventListener("resize", update);
      observer.disconnect();
    };
  }, [platform]);
  return portrait;
}
