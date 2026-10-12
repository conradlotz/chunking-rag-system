import { redirect } from "next/navigation";

// The front door is the question box; the corpus dashboard lives at /corpus.
export default function Home() {
  redirect("/search");
}
