import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { scaffoldSettings } from "./vcc/src/core/settings";
import { registerBeforeCompactHook } from "./hybrid";
import { registerPiVccCommand } from "./vcc/src/commands/pi-vcc";
import { registerVccRecallCommand } from "./vcc/src/commands/vcc-recall";
import { registerRecallTool } from "./vcc/src/tools/recall";

export default (pi: ExtensionAPI) => {
  scaffoldSettings();
  registerBeforeCompactHook(pi);
  registerPiVccCommand(pi);
  registerVccRecallCommand(pi);
  registerRecallTool(pi);
};
