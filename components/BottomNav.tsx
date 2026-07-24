type Props = {
  page: string;
  onChange: (page: string) => void;
};

const items = [
  { id: "home", icon: "🏠", label: "ホーム" },
  { id: "register", icon: "➕", label: "登録" },
  { id: "history", icon: "📖", label: "履歴" },
  { id: "ranking", icon: "🏆", label: "分析" },
];

export default function BottomNav({
  page,
  onChange,
}: Props) {
  return (
    <nav className="fixed inset-x-0 bottom-0 border-t border-zinc-800 bg-zinc-950/95 backdrop-blur">
      <div className="mx-auto grid max-w-md grid-cols-4">
        {items.map((item) => (
          <button
            key={item.id}
            onClick={() => onChange(item.id)}
            className={`flex flex-col items-center gap-1 py-3 text-xs ${
              page === item.id
                ? "font-bold text-amber-400"
                : "text-zinc-500"
            }`}
          >
            <span className="text-lg">{item.icon}</span>
            {item.label}
          </button>
        ))}
      </div>
    </nav>
  );
}