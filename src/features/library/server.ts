// Component library, server exports (architecture v3 section 4.8). Import in route handlers, server
// components and tools. Importing this module also registers the library with the components
// subsystem, so the guest resolver can expand instances and the Insert tab lists saved components.
import "server-only";
import { registerLibraryLookup } from "@/features/components/page";
import { registerLibraryCatalogue } from "@/features/components/insert";
import { libraryForDoc, listLibrary } from "./repo";

registerLibraryLookup(libraryForDoc);
registerLibraryCatalogue((p) => {
  try {
    return listLibrary(p);
  } catch {
    return [];
  }
});

export { listLibrary, getLibrary, saveLibrary, importLibrary, importMatch, freeName, deleteLibrary, libraryForDoc, libraryActor, registerLibraryDeleteHandler } from "./repo";
export type { SaveInput, LibraryListItem, ImportMatch } from "./repo";
export { toComponentFile, parseComponentFile, COMPONENT_FILE_EXT, CONTAINS_CODE_NOTICE } from "./file";
