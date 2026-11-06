import { useEffect, useRef, useState } from "react";
import { useSignIn, useUser } from "@clerk/react";
import { useLocation } from "wouter";
import {
  completeReviewerSignIn,
  reviewerSignInReadiness,
  REVIEWER_SIGN_IN_ALREADY_AUTHENTICATED,
  REVIEWER_SIGN_IN_ERROR,
} from "@/lib/reviewer-sign-in";

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
  const { signIn } = useSignIn();
  const { isLoaded, isSignedIn } = useUser();
  const [, setLocation] = useLocation();
  const [failed, setFailed] = useState(false);
  const [alreadySignedIn, setAlreadySignedIn] = useState(false);
  const attempted = useRef(false);

  useEffect(() => {
    if (attempted.current) return;
    const readiness = reviewerSignInReadiness({
      isLoaded,
      isSignedIn,
      hasSignIn: Boolean(signIn),
    });
    if (readiness === "waiting") return;
    if (readiness === "already-signed-in") {
      attempted.current = true;
      setAlreadySignedIn(true);
      return;
    }

    const currentUrl = new URL(window.location.href);
    const token = currentUrl.searchParams.get("token");
    attempted.current = true;
    if (!token) {
      setFailed(true);
      return;
    }

    currentUrl.searchParams.delete("token");
    window.history.replaceState(
      null,
      "",
      `${currentUrl.pathname}${currentUrl.search}${currentUrl.hash}`,
    );

    void (async () => {
      try {
        await completeReviewerSignIn(
          token,
          async (ticket) => {
            const { error } = await signIn.create({ strategy: "ticket", ticket });
            if (error) throw error;
            return {
              status: signIn.status,
              createdSessionId: signIn.createdSessionId,
            };
          },
          async () => {
            const { error } = await signIn.finalize();
            if (error) throw error;
          },
        );
        const target = await getConsoleTarget();
        setLocation(target, { replace: true });
      } catch {
        setFailed(true);
      }
    })();
  }, [isLoaded, isSignedIn, signIn, setLocation]);

  const status = alreadySignedIn ? "already-signed-in" : failed ? "error" : "loading";

  return (
    <main className="min-h-screen bg-void text-text flex items-center justify-center p-6">
      <p
        data-testid={`status-reviewer-sign-in-${status}`}
        role={failed ? "alert" : "status"}
        className="max-w-xl text-center text-sm"
      >
        {alreadySignedIn
          ? REVIEWER_SIGN_IN_ALREADY_AUTHENTICATED
          : failed
            ? REVIEWER_SIGN_IN_ERROR
            : "Signing you in…"}
      </p>
    </main>
  );
}
