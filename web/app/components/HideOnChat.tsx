// web/app/components/HideOnChat.tsx
"use client";

import { usePathname } from "next/navigation";
import { PropsWithChildren } from "react";

export default function HideOnChat({ children }: PropsWithChildren) {
  const pathname = usePathname();
  if (pathname === "/chat" || pathname.startsWith("/chat/")) {
    return null;
  }
  return <>{children}</>;
}
