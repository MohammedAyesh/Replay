import { createClerkClient } from "@clerk/express";

const clerkClient = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY });

export async function createClerkSignInToken(userId: string, expiresInSeconds: number): Promise<string> {
  const result = await clerkClient.signInTokens.createSignInToken({ userId, expiresInSeconds });
  if (typeof result.token !== "string" || result.token.length === 0) {
    throw new Error("Clerk did not return a sign-in token");
  }
  return result.token;
}
