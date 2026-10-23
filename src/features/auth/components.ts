// Auth's UI exports (architecture section 2). Client components; mount them from server pages.
// Settings (A4.4) should mount the two server panels instead of these pieces:
//   import { UsersSettingsPanel, SecuritySettingsPanel } from "@/features/auth/settings-panels";
// The pieces stay exported for other hosts:
//   <UsersManager initial={await loadUsersPage(headers)} />   people, allowlist, invite and reset links
//   <PasswordPanel hasPassword />, <TwoFactorPanel enabled hasPassword />, <SessionsPanel />  own security
//   <StepUpProvider> + useStepUp(), or <StepUpSheet>           step-up before sensitive operations
export { UsersManager } from "./ui/users-manager";
export { PasswordPanel, SessionsPanel, TwoFactorPanel } from "./ui/account-security";
export { StepUpSheet, StepUpPanel, StepUpProvider, useStepUp } from "./ui/step-up";
export type { StepUpMethod } from "./ui/step-up";
export { ConsentFlow, ConsentScreen, SCOPE_TEXT } from "./ui/consent-screen";
export { QrCode } from "./ui/qr-code";
export { SignInForm } from "./ui/sign-in-form";
// Guest links (round 3). app-builder mounts <GuestLinkPanel appId={app.id} /> on /build/<slug>/settings,
// and renders <GuestExpiredScreen /> on /a/<slug> when getGuestViewer() finds an ended guest session.
export { GuestLinkPanel } from "./ui/guest-link-panel";
export type { PanelData as GuestLinkPanelData } from "./ui/guest-link-panel";
export { GuestExpiredScreen, GuestScreen } from "./ui/guest-screens";
