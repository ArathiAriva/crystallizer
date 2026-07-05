import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Crystallizer",
  description: "Turn any audio into piano notes you can learn",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, background: "#0f1117", color: "#e6e6e6", fontFamily: "system-ui, sans-serif" }}>
        {children}
      </body>
    </html>
  );
}
