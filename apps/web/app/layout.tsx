import type { Metadata } from "next";
import "@fontsource-variable/manrope";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "./globals.css";
import "./redesign.css";
import { Header } from "@/components/header";
export const metadata: Metadata = {
  title: {
    default: "Agent — Your terminal. Your models. Your call.",
    template: "%s · Agent",
  },
  description:
    "A model-flexible coding agent in your terminal. Inspect every step, control permissions, and build on an open TypeScript foundation.",
};
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>
        <a className="skip-link" href="#main">
          Skip to content
        </a>
        <Header />
        {children}
      </body>
    </html>
  );
}
