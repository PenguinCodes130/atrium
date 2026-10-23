import { Tag, Window } from "@/features/shell";
import { settingsSession } from "@/features/settings/page-auth";

export const dynamic = "force-dynamic";
export const metadata = { title: "Agents" };

// Mounts the agents subsystem's panel once it exists (architecture section 2). Until then one quiet window
// (settings gauntlet w2-r1 item 16): a title-3 line and one sentence; the empty room is kept for real
// empty states.
export default async function AgentsPage() {
  await settingsSession("/settings/agents");
  return (
    <div className="max-w-[560px]" data-settings-tab="agents">
      <Window title="settings / agents" status={<Tag>soon</Tag>} data-placeholder-tab>
        <h2 className="type-title-3 text-fg">Agents settings are coming in a later update.</h2>
        <p className="mt-2 type-body text-fg-2">They arrive with the agent API; the rest of Settings works now.</p>
      </Window>
    </div>
  );
}
