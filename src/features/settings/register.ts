// Side-effect module: feeds the shell clock readout's instance name from the settings store
// (architecture v3 A1.7). Imported by the settings layout, and (shared file request) by the shell layout
// so the readout follows the setting on every screen from the first request.
import "server-only";
import { registerInstanceName } from "@/features/shell/server";
import { getInstanceSettings } from "./store";

registerInstanceName(() => {
  try {
    return getInstanceSettings().instanceName;
  } catch {
    return null;
  }
});
