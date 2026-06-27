import React, { createContext, useContext, useEffect, useState } from "react";
import { useGetMe, User } from "@workspace/api-client-react";

interface AuthContextType {
  user: User | null;
  isLoading: boolean;
  setUserId: (id: number | null) => void;
  isGuest: boolean;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [userId, setUserId] = useState<number | null>(() => {
    const stored = localStorage.getItem("soccerwatch_user_id");
    return stored ? parseInt(stored, 10) : null;
  });

  const { data: user, isLoading: isMeLoading } = useGetMe({
    query: {
      enabled: !!userId,
      retry: false,
    },
  });

  useEffect(() => {
    if (userId) {
      localStorage.setItem("soccerwatch_user_id", userId.toString());
    } else {
      localStorage.removeItem("soccerwatch_user_id");
    }
  }, [userId]);

  const isLoading = !!userId && isMeLoading;
  const isGuest = user?.isGuest ?? false;

  return (
    <AuthContext.Provider
      value={{
        user: user ?? null,
        isLoading,
        setUserId,
        isGuest,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
}
