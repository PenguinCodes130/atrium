import tseslint from "typescript-eslint";
import react from "eslint-plugin-react";

// Architecture section 11: only these folders may import the vault's unseal.
const UNSEAL_ALLOWED = [
  "src/features/vault/**",
  "src/features/integrations/host/**",
  "src/features/notifications/channels/**",
  "src/features/setup-agent/model/**",
  "src/features/backup/secrets.ts", // amendment A4.4: re-seals secret values into the password-sealed backup part
];

export default tseslint.config(
  { ignores: [".next/**", ".next-*/**", "node_modules/**", "src/db/migrations/**", "test-results/**", "public/sandbox/lib/**", "evidence/**"] },
  ...tseslint.configs.recommended,
  {
    plugins: { react },
    settings: { react: { version: "19" } },
    rules: {
      "react/no-danger": "error",
      "no-restricted-imports": ["error", { paths: [
        { name: "@/features/vault/unseal", message: "Only the callers in architecture section 11 may unseal secrets." },
        { name: "@/features/vault/cipher", message: "Vault internals: use seal() or the unseal module." },
        { name: "@/features/vault/key", message: "Vault internals: use seal() or the unseal module." },
      ] }],
    },
  },
  { files: UNSEAL_ALLOWED, rules: { "no-restricted-imports": "off" } },
);
