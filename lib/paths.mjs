import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const dataRoot = fileURLToPath(new URL("../data/", import.meta.url));

export function panelPaths(customDir = process.env.OS_DASHBOARD_DATA_DIR) {
  const dir = resolve(customDir || join(dataRoot, "current"));
  return {
    dir,
    logs: resolve(process.env.OS_DASHBOARD_LOG_DIR || join(customDir || dataRoot, "logs")),
    nativeWorkshop: join(dir, "workshop-local.sqlite"),
  };
}
