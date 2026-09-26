import { useQuery } from "@tanstack/react-query";

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");
const apiBase = `${basePath}/api`;

export type ClientSettingsResponse = {
  settings: Record<string, number | boolean | string>;
};

export function supportMailto(email: string): string | null {
  const trimmedEmail = email.trim();
  return trimmedEmail.includes("@") ? `mailto:${trimmedEmail}` : null;
}

export function useClientSettings() {
  return useQuery({
    queryKey: ["client-settings"],
    queryFn: async (): Promise<ClientSettingsResponse> => {
      const response = await fetch(`${apiBase}/client-settings`, {
        credentials: "include",
      });
      if (!response.ok) {
        throw new Error(`Client settings request failed (${response.status})`);
      }
      return response.json() as Promise<ClientSettingsResponse>;
    },
    staleTime: 5 * 60_000,
  });
}

export function useSupportContact(): { company: string; supportEmail: string } {
  const settings = useClientSettings().data?.settings;
  const rawCompany = settings?.["legal.companyName"];
  const rawEmail = settings?.["support.email"];
  const company = typeof rawCompany === "string" && rawCompany.trim()
    ? rawCompany.trim()
    : "Replay";
  const email = typeof rawEmail === "string" ? rawEmail.trim() : "";

  return {
    company,
    supportEmail: email.includes("@") ? email : "",
  };
}