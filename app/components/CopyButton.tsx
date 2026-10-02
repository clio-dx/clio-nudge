"use client";

import { useState } from "react";

async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Older browsers / insecure contexts
    const el = document.createElement("textarea");
    el.value = text;
    el.setAttribute("readonly", "");
    el.style.position = "fixed";
    el.style.opacity = "0";
    document.body.appendChild(el);
    el.select();
    document.execCommand("copy");
    el.remove();
  }
}

export function CopyButton({ text, onCopy, label = "복사" }: { text: string; onCopy?: () => void; label?: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <button
      type="button"
      onClick={async (e) => {
        e.stopPropagation();
        await copyText(text);
        onCopy?.();
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1600);
      }}
      className={`shrink-0 rounded-md px-3 py-1.5 text-xs font-semibold transition-colors ${
        copied
          ? "bg-green-600 text-white"
          : "bg-[#4A154B] text-white hover:bg-[#611f64]"
      }`}
      aria-live="polite"
    >
      {copied ? "복사됨 ✓" : label}
    </button>
  );
}
