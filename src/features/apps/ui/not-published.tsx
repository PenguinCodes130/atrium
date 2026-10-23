// An editor opening a never-published app (spec "App viewer", criterion 38): "Not published yet" with
// "Open the builder". Everyone else gets the not-found room instead.
import { Button, EmptyRoom } from "@/features/shell";

export function NotPublished({ slug, name }: { slug: string; name: string }) {
  return (
    <div className="flex min-h-dvh flex-col bg-bg" data-not-published>
      <EmptyRoom headingLevel={1} title="Not published yet" body={`${name} has a draft but no published version. Publish it from the builder to open it here.`} actions={<Button variant="primary" href={`/build/${slug}`} data-open-builder>Open the builder</Button>} />
    </div>
  );
}
