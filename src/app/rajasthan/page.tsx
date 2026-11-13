import type { Metadata } from "next";
import { Libre_Baskerville, Playfair_Display } from "next/font/google";
import RajasthanDashboard from "@/components/rajasthan/RajasthanDashboard";

// Loaded only on this route and exposed as CSS variables used by RajasthanDashboard.css:
// Playfair Display for the large numbers, Libre Baskerville for the card labels.
const playfair = Playfair_Display({
  subsets: ["latin"],
  variable: "--font-rj-serif",
  display: "swap",
});

const baskerville = Libre_Baskerville({
  subsets: ["latin"],
  weight: "700",
  variable: "--font-rj-label",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Visitors · Rajasthan",
  description: "Today's and total visitors",
};

export default function RajasthanPage() {
  return <RajasthanDashboard fontClassName={`${playfair.variable} ${baskerville.variable}`} />;
}
