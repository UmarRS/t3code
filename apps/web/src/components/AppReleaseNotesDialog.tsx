import { SparklesIcon } from "lucide-react";
import { useEffect, useState } from "react";

import {
  currentReleaseNotes,
  RELEASE_NOTES_STORAGE_KEY,
  shouldShowReleaseNotes,
} from "~/releaseNotes";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";

const release = currentReleaseNotes();

export function AppReleaseNotesDialog() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (release === null) return;
    try {
      setOpen(shouldShowReleaseNotes(release, localStorage.getItem(RELEASE_NOTES_STORAGE_KEY)));
    } catch {
      setOpen(true);
    }
  }, []);

  if (release === null) return null;

  const dismiss = () => {
    try {
      localStorage.setItem(RELEASE_NOTES_STORAGE_KEY, release.version);
    } catch {
      // Storage can be unavailable in locked-down browsers; closing still works for this session.
    }
    setOpen(false);
  };

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => (nextOpen ? setOpen(true) : dismiss())}>
      <DialogPopup>
        <DialogHeader>
          <div className="mb-1 flex size-9 items-center justify-center rounded-xl bg-accent text-accent-foreground">
            <SparklesIcon className="size-4" />
          </div>
          <DialogTitle>What’s new in Atlas v{release.version}</DialogTitle>
          <DialogDescription>A quick summary of the changes in this build.</DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <ul className="grid gap-3">
            {release.changes.map((change) => (
              <li key={change} className="flex gap-3 text-sm leading-6 text-foreground">
                <span
                  className="mt-2 size-1.5 shrink-0 rounded-full bg-primary"
                  aria-hidden="true"
                />
                <span>{change}</span>
              </li>
            ))}
          </ul>
        </DialogPanel>
        <DialogFooter>
          <Button onClick={dismiss}>Continue</Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
