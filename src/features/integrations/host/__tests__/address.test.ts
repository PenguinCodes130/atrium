import { describe, expect, it } from "vitest";
import { checkAddress, expandIpv6, isPrivateAddress } from "../address";
import { resolveChecked } from "../request";

describe("address rules", () => {
  it.each([
    "169.254.169.254", "169.254.0.1", "169.254.255.255",
    "fe80::1", "fe80::abcd:1234", "febf::1", "FE80::1%eth0", "[fe80::1]",
    "fd00:ec2::254", "fd00:ec2::1", "fd00:ec2:0:0:ffff::1",
    "::ffff:169.254.169.254", "::ffff:a9fe:a9fe", "64:ff9b::a9fe:a9fe", "::169.254.169.254",
  ])("refuses %s", (ip) => {
    expect(checkAddress(ip).blocked).toBe(true);
  });

  it.each(["10.77.99.7", "10.0.0.1", "192.168.1.1", "172.16.0.1", "127.0.0.1", "::1", "100.64.0.1", "8.8.8.8", "fd00::1", "fd00:ec3::1", "fec0::1", "::ffff:10.0.0.1", "169.253.255.255", "169.255.0.1"])("allows %s", (ip) => {
    expect(checkAddress(ip).blocked).toBe(false);
  });

  it("expands IPv6 forms", () => {
    expect(expandIpv6("fd00:ec2::254")).toEqual([0xfd00, 0xec2, 0, 0, 0, 0, 0, 0x254]);
    expect(expandIpv6("::ffff:1.2.3.4")).toEqual([0, 0, 0, 0, 0, 0xffff, 0x0102, 0x0304]);
  });

  it("resolveChecked refuses literal metadata addresses and allows LAN and loopback", async () => {
    await expect(resolveChecked("169.254.169.254")).rejects.toMatchObject({ adapterError: { code: "permission" } });
    await expect(resolveChecked("[fe80::1]")).rejects.toMatchObject({ adapterError: { code: "permission" } });
    await expect(resolveChecked("[fd00:ec2::254]")).rejects.toMatchObject({ adapterError: { code: "permission" } });
    await expect(resolveChecked("10.77.99.7")).resolves.toHaveLength(1);
    await expect(resolveChecked("127.0.0.1")).resolves.toHaveLength(1);
    await expect(resolveChecked("localhost")).resolves.not.toHaveLength(0);
  });
});

describe("isPrivateAddress unwraps 6to4 and Teredo (settings r3 shared file request)", () => {
  it.each(["2002:7f00:1::", "2002:a00:1::", "2002:c0a8:101::1", "2001:0:5db8:d70e::80ff:fffe", "2001:0:a00:1::a247:28f1"])("%s is not public", (ip) => {
    expect(isPrivateAddress(ip)).toBe(true);
  });
  it.each(["2002:5db8:d70e::", "2001:0:5db8:d70e::a247:28f1", "2001:db8::1", "2606:4700::1111"])("%s stays public", (ip) => {
    expect(isPrivateAddress(ip)).toBe(false);
  });
});
