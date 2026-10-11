import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono, Instrument_Serif } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

// Display face for the wordmark and the few "moment" headlines.
const instrumentSerif = Instrument_Serif({
  variable: "--font-instrument-serif",
  subsets: ["latin"],
  weight: "400",
  style: ["normal", "italic"],
});

export const metadata: Metadata = {
  title: "Pulse - a living globe of strangers",
  description:
    "Every online person is a glowing dot on the globe. Tap one, start talking. No accounts, nothing stored.",
  openGraph: {
    title: "Pulse",
    description: "A living globe of strangers. Tap a dot, start talking.",
  },
};

export const viewport: Viewport = {
  themeColor: "#05060b",
  colorScheme: "dark",
  // Lets the UI extend under the notch / home indicator; safe-area insets
  // are applied where it matters.
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} ${instrumentSerif.variable} h-full antialiased`}
    >
      <body className="min-h-full">{children}</body>
    </html>
  );
}
