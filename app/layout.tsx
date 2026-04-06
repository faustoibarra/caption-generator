import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Caption Generator',
  description: 'Automate athlete identification in sports photos',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
