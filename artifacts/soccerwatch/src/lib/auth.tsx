import { useUser } from "@clerk/react";
import { useGetMe, getGetMeQueryKey, type User } from "@workspace/api-client-react";

export type { User };

export function useAuth() {
  const { isSignedIn, isLoaded } = useUser();

  const { data: localUser, isLoading: isMeLoading } = useGetMe({
    query: {
      enabled: isLoaded,
      // Retry when Clerk says the user IS signed in but the server returns an
      // error — this handles the race condition where the Clerk session cookie
      // is set in the browser but the server middleware hasn't verified it yet.
      // For genuinely unauthenticated users (isSignedIn = false) we skip retries
      // so the login screen appears instantly.
      retry: (failureCount) => isSignedIn === true && failureCount < 3,
      retryDelay: 600,
      staleTime: 5 * 60 * 1000,
      queryKey: getGetMeQueryKey(),
    },
  });

  const user = localUser ?? null;
  const isLoading = !isLoaded || (isLoaded && isMeLoading && isSignedIn === true);
  const isGuest = user?.isGuest ?? false;
  const isAdmin = user?.isAdmin ?? false;

  const setUser = (_u: User | null) => {};

  return { user, isLoading, isGuest, isAdmin, setUser };
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
