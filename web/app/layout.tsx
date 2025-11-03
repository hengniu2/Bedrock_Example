import "./globals.css";
import type { Metadata } from "next";
import HideOnChat from "./components/HideOnChat";

export const metadata: Metadata = {
  title: "Bedrock Codegen Demo",
  description: "Chat-driven code generation for a Next.js app"
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-slate-950 text-slate-100">
        {/* Page content */}
        <div className="min-h-[calc(100vh-3.25rem)]">{children}</div>
      </body>
    </html>
  );
}