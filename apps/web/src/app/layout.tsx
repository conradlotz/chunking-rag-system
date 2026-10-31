import type { Metadata, Viewport } from "next";
import "./globals.css";

const siteUrl = "https://rag.conradlotz.com";
const title = "Chunking Lab — how chunking and search choices shape RAG retrieval";
const description =
  "A RAG research lab over SEC 10-K filings measuring how document structure, chunking strategy, hybrid retrieval and context construction change what a retriever finds. By Conrad Lotz.";

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: { default: title, template: "%s · Chunking Lab" },
  description,
  applicationName: "Chunking Lab",
  authors: [{ name: "Conrad Lotz", url: "https://www.conradlotz.com" }],
  creator: "Conrad Lotz",
  openGraph: {
    type: "website",
    siteName: "Chunking Lab",
    url: siteUrl,
    title,
    description,
  },
  twitter: {
    card: "summary",
    creator: "@conradlotz",
    title,
    description,
  },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f5f2ea" },
    { media: "(prefers-color-scheme: dark)", color: "#12100d" },
  ],
};

const themeScript = `try{var t=localStorage.getItem('lab-theme');if(t==='light'||t==='dark')document.documentElement.setAttribute('data-theme',t)}catch(e){}`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
