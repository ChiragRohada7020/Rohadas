import { useMemo, useState } from "react";
import { trpc } from "@/lib/trpc";
import { useDebounce } from "@/hooks/useDebounce";
import { Combobox, type ComboboxOption } from "@/components/ui/Combobox";

interface ItemComboboxProps {
  value: string;
  onChange: (itemId: string) => void;
  label?: string;
  required?: boolean;
  error?: string;
  placeholder?: string;
  autoFocus?: boolean;
}

export function ItemCombobox({
  value,
  onChange,
  label = "Item",
  required,
  error,
  placeholder = "Search items...",
  autoFocus,
}: ItemComboboxProps) {
  const [search, setSearch] = useState("");
  const debouncedSearch = useDebounce(search, 300);

  const { data, isFetching } = trpc.item.list.useQuery({
    search: debouncedSearch || undefined,
    page: 1,
    limit: 50,
  });

  const { data: selectedItem } = trpc.item.getById.useQuery(
    { id: value },
    { enabled: !!value }
  );

  const options: ComboboxOption[] = useMemo(() => {
    const list = (data?.data ?? []).map((i) => ({
      value: i.id,
      label: i.name,
      description: i.itemType ?? undefined,
    }));
    if (selectedItem && !list.some((o) => o.value === selectedItem.id)) {
      list.unshift({
        value: selectedItem.id,
        label: selectedItem.name,
        description: selectedItem.itemType ?? undefined,
      });
    }
    return list;
  }, [data, selectedItem]);

  return (
    <Combobox
      label={label}
      required={required}
      value={value}
      onChange={onChange}
      options={options}
      placeholder={placeholder}
      emptyMessage="No items found"
      onQueryChange={setSearch}
      isLoading={isFetching && !!debouncedSearch}
      error={error}
      autoFocus={autoFocus}
    />
  );
}
