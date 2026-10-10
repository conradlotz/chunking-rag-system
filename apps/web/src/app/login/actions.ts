"use server";

import { redirect } from "next/navigation";
import { fixtureMode } from "@/lib/env";
import { createClient } from "@/lib/supabase/server";

export interface LoginState {
  error?: string;
}

/** Only same-site relative paths are accepted as a post-login destination. */
function safeNext(raw: FormDataEntryValue | null): string {
  const next = typeof raw === "string" ? raw : "";
  return next.startsWith("/") && !next.startsWith("//") && !next.startsWith("/login") ? next : "/";
}

export async function signIn(_prev: LoginState | undefined, formData: FormData): Promise<LoginState> {
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  if (!email || !password) return { error: "Enter your email and password." };
  if (fixtureMode()) redirect("/");

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) {
    // One generic message: never reveal whether the email exists.
    return { error: "That email and password don't match." };
  }
  redirect(safeNext(formData.get("next")));
}

export async function signOut() {
  if (!fixtureMode()) {
    const supabase = await createClient();
    await supabase.auth.signOut();
  }
  redirect("/login");
}
