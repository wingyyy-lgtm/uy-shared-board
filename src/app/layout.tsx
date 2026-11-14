import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "UY · 共享背景板 | 多模型对照",
  description: "同一个问题发给两个 AI，让它们看到同一份背景事实，各自独立回答，再对照分歧。",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="zh-CN" className="h-full antialiased">
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
