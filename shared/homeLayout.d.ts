export interface HomeLayout {
  daily: true;
  starter: boolean;
  starterOpen: boolean;
  starterCompact: boolean;
  personal: boolean;
  order: ('daily' | 'starter' | 'personal')[];
}
export function homeLayout(s: { core: boolean; starter: boolean; userBookCount: number; starterOpen: boolean }): HomeLayout;
