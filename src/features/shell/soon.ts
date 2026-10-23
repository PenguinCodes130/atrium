"use client";
// A tap or click on a shell destination that has no route yet says so (touch has no hover tooltip).
import { toast } from "./toast";

export function announceSoon(label: string) {
  toast.info(`${label} is coming in a later update`, { description: "This part of Atrium is not built yet." });
}
