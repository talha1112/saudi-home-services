import type { Metadata } from "next";
import localFont from "next/font/local";
import "./globals.css";

const archivo = localFont({
  variable: "--font-archivo",
  src: [
    { path: "../fonts/Archivo-400.ttf", weight: "400" },
    { path: "../fonts/Archivo-500.ttf", weight: "500" },
    { path: "../fonts/Archivo-600.ttf", weight: "600" },
    { path: "../fonts/Archivo-700.ttf", weight: "700" },
    { path: "../fonts/Archivo-800.ttf", weight: "800" },
  ],
});

const tajawal = localFont({
  variable: "--font-tajawal",
  src: [
    { path: "../fonts/Tajawal-400.ttf", weight: "400" },
    { path: "../fonts/Tajawal-500.ttf", weight: "500" },
    { path: "../fonts/Tajawal-700.ttf", weight: "700" },
    { path: "../fonts/Tajawal-800.ttf", weight: "800" },
  ],
});

export const metadata: Metadata = {
  title: "Home Services Admin",
  description: "Home Services super admin portal",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${archivo.variable} ${tajawal.variable} h-full antialiased`}>
      <body className="h-full">{children}</body>
    </html>
  );
}
