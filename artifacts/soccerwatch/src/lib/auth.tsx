import { useUser } from "@clerk/react";
import { useGetMe, getGetMeQueryKey, type User } from "@workspace/api-client-react";

export type { User };

export function useAuth() {
  const { isSignedIn, isLoaded } = useUser();

  const { data: localUser, isLoading: isMeLoading } = useGetMe({
    query: {
      enabled: isLoaded,
      retry: false,
      staleTime: 5 * 60 * 1000,
      queryKey: getGetMeQueryKey(),
    },
  });

  const user = localUser ?? null;
  const isLoading = !isLoaded || (isLoaded && isMeLoading && isSignedIn === true);
  const isGuest = user?.isGuest ?? false;

  const setUser = (_u: User | null) => {};

  return { user, isLoading, isGuest, setUser };
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
