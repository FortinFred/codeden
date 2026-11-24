import { OPENSPEC_CHANGE_BODY_MAX, OPENSPEC_CHANGE_TITLE_MAX } from "@codeden/contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { FilePlus2 } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useClient } from "@/lib/api";
import { factoryKeys } from "@/lib/factory";

/**
 * "New change" for an OpenSpec work source: a title and a body (why and what) become
 * `openspec/changes/<slug>/proposal.md` in the project's main checkout. The next factory check
 * takes the change in, as for one made with the OpenSpec CLI.
 */
export function NewChangeButton({ projectId }: { projectId: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>
        <FilePlus2 /> New change
      </Button>
      <NewChangeDialog projectId={projectId} open={open} onOpenChange={setOpen} />
    </>
  );
}

function NewChangeDialog({
  projectId,
  open,
  onOpenChange,
}: {
  projectId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const client = useClient();
  const queryClient = useQueryClient();
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const create = useMutation({
    mutationFn: () =>
      client.factory.createOpenSpecChange(projectId, { title: title.trim(), body: body.trim() }),
    onSuccess: (result) => {
      toast.success("Change created", { description: result.message });
      onOpenChange(false);
      void queryClient.invalidateQueries({ queryKey: factoryKeys.all });
    },
    onError: (error: Error) =>
      toast.error("Couldn't create the change", { description: error.message }),
  });
  useEffect(() => {
    if (open) return;
    setTitle("");
    setBody("");
  }, [open]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!title.trim() || create.isPending) return;
    create.mutate();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>New OpenSpec change</DialogTitle>
          <DialogDescription>
            Writes <code className="font-mono">openspec/changes/&lt;id&gt;/proposal.md</code> in the
            project. The next factory check takes it in as a feature.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="grid gap-3">
          <label htmlFor="openspec-change-title" className="grid gap-1.5 text-xs">
            <span className="font-medium">Title</span>
            <Input
              id="openspec-change-title"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              maxLength={OPENSPEC_CHANGE_TITLE_MAX}
              placeholder="Add gift cards to checkout"
              autoFocus
            />
            <span className="text-3xs text-muted-foreground">
              The proposal's heading; its folder is a slug of it.
            </span>
          </label>
          <label htmlFor="openspec-change-body" className="grid gap-1.5 text-xs">
            <span className="font-medium">Why and what</span>
            <Textarea
              id="openspec-change-body"
              value={body}
              onChange={(event) => setBody(event.target.value)}
              maxLength={OPENSPEC_CHANGE_BODY_MAX}
              placeholder="What should change, for whom, and why it matters."
              className="min-h-32"
            />
          </label>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!title.trim() || create.isPending}>
              {create.isPending ? "Creating…" : "Create change"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
