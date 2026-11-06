import { useEffect, useRef, useState } from "react";
import { useClerk } from "@clerk/react";
import { useSignIn } from "@clerk/react/legacy";
import { useLocation } from "wouter";
import { completeReviewerSignIn, REVIEWER_SIGN_IN_ERROR } from "@/lib/reviewer-sign-in";

type ConsoleTarget = "/academy" | "/field" | "/owner";
const apiBase = `${(import.meta.env.BASE_URL ?? "/").replace(/\/$/, "")}/api`;

async function getConsoleTarget(): Promise<ConsoleTarget> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(`${apiBase}/me/console-home`, {
        credentials: "include",
        cache: "no-store",
      });
      if (response.ok) {
        const body = (await response.json()) as { target?: unknown };
        if (body.target === "/academy" || body.target === "/field" || body.target === "/owner") {
          return body.target;
        }
        return "/academy";
      }
    } catch {
      // Session cookies can take a moment to reach the API after activation.
    }
    if (attempt < 2) {
      await new Promise((resolve) => window.setTimeout(resolve, 300));
    }
  }
  return "/academy";
}

export default function ReviewerSignInPage() {
  const { isLoaded, signIn } = useSignIn();
  const { setActive } = useClerk();
  const [, setLocation] = useLocation();
  const [failed, setFailed] = useState(false);
  const attempted = useRef(false);

  useEffect(() => {
    if (!isLoaded || attempted.current) return;
    attempted.current = true;

    const token = new URLSearchParams(window.location.search).get("token");
    window.history.replaceState(null, "", `${window.location.pathname}${window.location.hash}`);
    if (!token || !signIn || !setActive) {
      setFailed(true);
      return;
    }

    void (async () => {
      try {
        await completeReviewerSignIn(
          token,
          (ticket) => signIn.create({ strategy: "ticket", ticket }),
          async (session) => {
            await setActive({ session });
          },
        );
        const target = await getConsoleTarget();
        setLocation(target, { replace: true });
      } catch {
        setFailed(true);
      }
    })();
  }, [isLoaded, signIn, setActive, setLocation]);

  return (
    <main className="min-h-screen bg-void text-text flex items-center justify-center p-6">
      <p
        data-testid={failed ? "status-reviewer-sign-in-error" : "status-reviewer-sign-in-loading"}
        role={failed ? "alert" : "status"}
        className="max-w-xl text-center text-sm"
      >
        {failed ? REVIEWER_SIGN_IN_ERROR : "Signing you in…"}
      </p>
    </main>
  );
}
