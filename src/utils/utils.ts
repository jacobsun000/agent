import { homedir } from "node:os";
import path from "node:path";

export const CONFIG_PATH = path.join(
  homedir(),
  ".agent",
);
