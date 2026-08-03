import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { scaffoldConfig } from "./src/config";
import { registerOcCompactHooks } from "./src/hooks";

export default (pi: ExtensionAPI) => {
  scaffoldConfig();
  registerOcCompactHooks(pi);
};
