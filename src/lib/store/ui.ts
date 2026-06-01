import { create } from "zustand";

interface UIState {
  selectedAssetIds: Set<string>;
  toggleSelection: (id: string) => void;
  clearSelection: () => void;
  theme: "light" | "dark" | "system";
  setTheme: (t: "light" | "dark" | "system") => void;
}

export const useUI = create<UIState>((set, get) => ({
  selectedAssetIds: new Set(),
  toggleSelection: (id) => {
    const next = new Set(get().selectedAssetIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    set({ selectedAssetIds: next });
  },
  clearSelection: () => set({ selectedAssetIds: new Set() }),
  theme: "system",
  setTheme: (theme) => set({ theme }),
}));