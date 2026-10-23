// Better Auth's endpoints behind Atrium's own checks (rate limits, allowlist, password rules).
import { handleAuthRequest } from "@/features/auth/server/handler";

export const dynamic = "force-dynamic";

export const GET = handleAuthRequest;
export const POST = handleAuthRequest;
