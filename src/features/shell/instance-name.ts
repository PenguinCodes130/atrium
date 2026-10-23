// The instance name shown in the clock readout and the sky band crumb (architecture v3 A1.7, Fix 9).
// Settings' "Instance name" wins once registered; until then the host name of ATRIUM_PUBLIC_URL,
// except that a bare IP address (or localhost) reads as a debug value, so it becomes "Atrium".
export const DEFAULT_INSTANCE_NAME = "Atrium";

const IPV4 = /^(?:\d{1,3}\.){3}\d{1,3}$/;

export function readableHost(hostname: string): string {
  const h = hostname.trim().replace(/^\[|\]$/g, "").toLowerCase();
  if (!h || IPV4.test(h) || h.includes(":") || h === "localhost" || h.endsWith(".localhost")) return DEFAULT_INSTANCE_NAME;
  return h.slice(0, 40);
}
