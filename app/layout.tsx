import './globals.css';
import Link from 'next/link';

export const metadata = {
  title: 'H2H OVERLAY - Broadcast Like a Pro',
  description: 'Cloud-synced scoreboard OBS overlays for amateur sports broadcasters.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const sports = ['ice-hockey', 'football', 'soccer', 'basketball', 'volleyball', 'lacrosse', 'baseball'];

  return (
    <html lang="en">
      <body className="bg-slate-900 text-slate-100 font-sans min-h-screen flex flex-col">
        <nav className="bg-[#1B365D] text-white p-4 shadow-md border-b border-slate-700">
          <div className="max-w-7xl mx-auto flex justify-between items-center">
            <Link href="/" className="flex items-center space-x-2">
              <span className="text-2xl font-black tracking-wider">
                H2H <span className="text-[#FF6B00]">OVERLAY</span>
              </span>
            </Link>
            
            <div className="hidden md:flex space-x-6 font-semibold text-sm items-center">
              <div className="group relative py-2">
                <button className="hover:text-[#FF6B00] transition">Sports Overlays ▾</button>
                <div className="absolute hidden group-hover:block bg-slate-800 text-white mt-1 py-2 w-48 shadow-xl rounded border border-slate-700">
                  {sports.map((sport) => (
                    <Link
                      key={sport}
                      href={`/sports/${sport}`}
                      className="block px-4 py-2 hover:bg-[#FF6B00] transition capitalize"
                    >
                      {sport.replace('-', ' ')}
                    </Link>
                  ))}
                </div>
              </div>
              <Link href="/pricing" className="hover:text-[#FF6B00] transition">Pricing</Link>
              <Link
                href="/pricing"
                className="bg-[#FF6B00] hover:bg-orange-600 text-white px-5 py-2 rounded font-bold transition"
              >
                Get Started Free
              </Link>
            </div>
          </div>
        </nav>
        <main className="flex-1">{children}</main>
        <footer className="bg-[#1B365D] text-slate-400 py-6 text-center border-t border-slate-800 text-sm">
          <p>© 2026 H2H Overlay. Broadcast like a pro.</p>
        </footer>
      </body>
    </html>
  );
}