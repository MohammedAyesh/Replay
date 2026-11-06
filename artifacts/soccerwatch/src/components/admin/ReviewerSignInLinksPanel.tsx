import { useState } from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { useCreateAdminReviewerSignInLinks } from "@workspace/api-client-react";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";

const formSchema = z.object({
  user: z.string().trim().min(1, "Enter a Replay account email or ID.").refine((value) => {
    if (/^\d+$/.test(value)) {
      const id = Number(value);
      return Number.isSafeInteger(id) && id > 0;
    }
    return z.string().email().safeParse(value).success;
  }, "Enter a valid Replay account email or positive ID."),
  count: z.number().int().min(1).max(5),
  validityDays: z.number().int().min(1).max(30),
});

type FormValues = z.infer<typeof formSchema>;

function requestError(error: unknown): string {
  if (typeof error === "object" && error !== null && "data" in error) {
    const data = (error as { data?: unknown }).data;
    if (typeof data === "object" && data !== null && "error" in data) {
      const message = (data as { error?: unknown }).error;
      if (typeof message === "string") return message;
    }
  }
  return "Could not create reviewer links. Check the email and try again.";
}

export function ReviewerSignInLinksPanel() {
  const createLinks = useCreateAdminReviewerSignInLinks();
  const [urls, setUrls] = useState<string[]>([]);
  const [generatedDays, setGeneratedDays] = useState<number | null>(null);
  const [copiedUrl, setCopiedUrl] = useState<string | null>(null);
  const [requestErrorMessage, setRequestErrorMessage] = useState<string | null>(null);
  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: { user: "", count: 3, validityDays: 30 },
  });

  const submit = async (values: FormValues) => {
    setRequestErrorMessage(null);
    setUrls([]);
    setCopiedUrl(null);
    try {
      const selector = /^\d+$/.test(values.user)
        ? { userId: Number(values.user) }
        : { email: values.user.trim() };
      const result = await createLinks.mutateAsync({
        data: {
          ...selector,
          count: values.count,
          validityDays: values.validityDays,
        },
      });
      setUrls(result.urls);
      setGeneratedDays(values.validityDays);
    } catch (error) {
      setRequestErrorMessage(requestError(error));
    }
  };

  const copyUrl = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      setCopiedUrl(url);
      setRequestErrorMessage(null);
    } catch {
      setRequestErrorMessage("Copy is unavailable. Select the link text and copy it manually.");
    }
  };

  return (
    <section
      className="rounded-xl border border-zinc-800 bg-zinc-900 p-4 space-y-4"
      data-testid="panel-reviewer-sign-in-links"
    >
      <div>
        <h2 className="text-white text-base font-semibold">Reviewer sign-in links</h2>
        <p className="mt-1 text-xs text-zinc-400">
          Create one-use links for an existing Replay account.
        </p>
      </div>

      <p
        className="rounded-lg border border-amber-700/40 bg-amber-950/30 px-3 py-2 text-xs text-amber-200"
        data-testid="text-reviewer-link-warning"
      >
        Each link signs directly into the selected account and works once. Share links only with the intended reviewer.
      </p>

      <Form {...form}>
        <form
          onSubmit={form.handleSubmit(submit)}
          noValidate
          className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_110px_130px_auto] sm:items-end"
        >
          <FormField
            control={form.control}
            name="user"
            render={({ field }) => (
              <FormItem>
                <FormLabel className="text-xs text-zinc-400">Replay user email or ID</FormLabel>
                <FormControl>
                  <input
                    {...field}
                    type="text"
                    placeholder="name@example.com or user ID"
                    data-testid="input-reviewer-user-identifier"
                    className="w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-white outline-none focus:border-primary"
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="count"
            render={({ field }) => (
              <FormItem>
                <FormLabel className="text-xs text-zinc-400">Link count</FormLabel>
                <FormControl>
                  <input
                    type="number"
                    min={1}
                    max={5}
                    step={1}
                    value={field.value}
                    onChange={(event) => field.onChange(event.target.valueAsNumber)}
                    data-testid="input-reviewer-link-count"
                    className="w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-white outline-none focus:border-primary"
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="validityDays"
            render={({ field }) => (
              <FormItem>
                <FormLabel className="text-xs text-zinc-400">Validity (days)</FormLabel>
                <FormControl>
                  <input
                    type="number"
                    min={1}
                    max={30}
                    step={1}
                    value={field.value}
                    onChange={(event) => field.onChange(event.target.valueAsNumber)}
                    data-testid="input-reviewer-link-validity"
                    className="w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-white outline-none focus:border-primary"
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <button
            type="submit"
            disabled={createLinks.isPending}
            data-testid="button-create-reviewer-links"
            className="rounded-lg bg-primary px-4 py-2.5 text-sm font-bold text-black disabled:opacity-50"
          >
            {createLinks.isPending ? "Creating…" : "Create links"}
          </button>
        </form>
      </Form>

      {requestErrorMessage && (
        <p
          role="alert"
          data-testid="status-reviewer-link-error"
          className="text-sm text-red-300"
        >
          {requestErrorMessage}
        </p>
      )}

      {urls.length > 0 && (
        <div className="space-y-2 border-t border-zinc-800 pt-3">
          <p className="text-xs text-zinc-400" data-testid="text-reviewer-link-expiry">
            {urls.length} links created. Each expires in {generatedDays} days.
          </p>
          <div className="space-y-2">
            {urls.map((url, index) => (
              <div key={url} className="flex items-center gap-2">
                <input
                  readOnly
                  value={url}
                  aria-label={`Reviewer sign-in link ${index + 1}`}
                  data-testid={`input-reviewer-link-${index + 1}`}
                  className="min-w-0 flex-1 rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 font-mono text-xs text-zinc-300"
                />
                <button
                  type="button"
                  onClick={() => void copyUrl(url)}
                  data-testid={`button-copy-reviewer-link-${index + 1}`}
                  className="shrink-0 rounded-lg bg-zinc-800 px-3 py-2 text-xs font-semibold text-white hover:bg-zinc-700"
                >
                  {copiedUrl === url ? "Copied" : "Copy"}
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
