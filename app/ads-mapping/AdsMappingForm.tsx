"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

type Campaign = {
  campaignName: string;
  spend: number;
  selectedVendorCodes: string[];
};

type VendorOption = {
  value: string;
  label: string;
};

type SavedMapping = {
  campaignName: string;
  vendorCode: string;
};

type SortField = "campaignName" | "spend";
type SortDirection = "asc" | "desc";

function parseVendorText(value: string) {
  return value
    .split(/[,\n;]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function AdsMappingTable({
  campaigns,
  vendorCodes,
  savedMappings,
  saveAllMappings,
  deleteCampaign,
  companyName,
}: {
  campaigns: Campaign[];
  vendorCodes: VendorOption[];
  savedMappings: SavedMapping[];
  saveAllMappings: (formData: FormData) => Promise<void>;
  deleteCampaign: (formData: FormData) => Promise<void>;
  companyName: string;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  const [sortField, setSortField] = useState<SortField>("spend");
  const [sortDirection, setSortDirection] = useState<SortDirection>("desc");
  const [campaignSearch, setCampaignSearch] = useState("");
  const [pageSize, setPageSize] = useState(20);
  const [page, setPage] = useState(1);

  const [selectedByCampaign, setSelectedByCampaign] = useState<
    Record<string, string[]>
  >(() =>
    Object.fromEntries(
      campaigns.map((campaign) => [
        campaign.campaignName,
        campaign.selectedVendorCodes,
      ])
    )
  );

  const filteredCampaigns = useMemo(() => {
    return campaigns
      .filter((campaign) =>
        campaign.campaignName
          .toLowerCase()
          .includes(campaignSearch.toLowerCase())
      )
      .sort((a, b) => {
        const direction = sortDirection === "asc" ? 1 : -1;

        if (sortField === "spend") {
          return (a.spend - b.spend) * direction;
        }

        return a.campaignName.localeCompare(b.campaignName) * direction;
      });
  }, [campaigns, campaignSearch, sortField, sortDirection]);

  const totalPages = Math.max(1, Math.ceil(filteredCampaigns.length / pageSize));

  const paginatedCampaigns = filteredCampaigns.slice(
    (page - 1) * pageSize,
    page * pageSize
  );


  function toggleSort(field: SortField) {
    if (sortField === field) {
      setSortDirection((current) => (current === "asc" ? "desc" : "asc"));
      return;
    }

    setSortField(field);
    setSortDirection(field === "spend" ? "desc" : "asc");
  }

  function updateSelected(campaignName: string, vendorCodes: string[]) {
    setSelectedByCampaign((current) => ({
      ...current,
      [campaignName]: Array.from(new Set(vendorCodes)),
    }));
  }

  function handleSaveAll() {
    const formData = new FormData();

formData.set("companyName", companyName);

    formData.set(
      "mappingsJson",
      JSON.stringify(
        campaigns.map((campaign) => ({
          campaignName: campaign.campaignName,
          vendorCodes: selectedByCampaign[campaign.campaignName] ?? [],
        }))
      )
    );

    startTransition(async () => {
      await saveAllMappings(formData);
      router.refresh();
    });
  }

  function handleDeleteCampaign(campaignName: string) {
    const formData = new FormData();

    formData.set("companyName", companyName);
    formData.set("deleteCampaignName", campaignName);

    startTransition(async () => {
      await deleteCampaign(formData);
      router.refresh();
    });
  }

  return (
    <div className="space-y-8">
      <div className="grid gap-4 rounded-2xl bg-white p-5 shadow-sm md:grid-cols-[1fr_auto]">
        <input
          value={campaignSearch}
          onChange={(event) => {
            setCampaignSearch(event.target.value);
            setPage(1);
          }}
          placeholder="Поиск рекламной кампании..."
          className="w-full rounded-xl border border-slate-300 px-4 py-3 outline-none transition focus:border-slate-500 focus:ring-2 focus:ring-slate-200"
        />

        <div className="flex items-center gap-3">
          <span className="text-sm text-slate-500">Показать записей</span>

          <select
            value={pageSize}
            onChange={(event) => {
              setPageSize(Number(event.target.value));
              setPage(1);
            }}
            className="rounded-xl border border-slate-300 px-4 py-3"
          >
            <option value={10}>10</option>
            <option value={20}>20</option>
            <option value={30}>30</option>
            <option value={50}>50</option>
            <option value={100}>100</option>
          </select>
        </div>
      </div>

      <div className="rounded-2xl bg-white p-3 shadow-sm">
        <table className="w-full border-separate border-spacing-y-2 text-sm">
          <thead className="text-left text-slate-700">
            <tr>
              <th className="w-[40%] rounded-l-xl bg-slate-100 p-4">
                <button
                  type="button"
                  onClick={() => toggleSort("campaignName")}
                  className="font-bold"
                >
                  Рекламная кампания{" "}
                  {sortField === "campaignName"
                    ? sortDirection === "asc"
                      ? "↑"
                      : "↓"
                    : ""}
                </button>
              </th>

              <th className="w-[14%] bg-slate-100 p-4">
                <button
                  type="button"
                  onClick={() => toggleSort("spend")}
                  className="font-bold"
                >
                  Расход{" "}
                  {sortField === "spend"
                    ? sortDirection === "asc"
                      ? "↑"
                      : "↓"
                    : ""}
                </button>
              </th>

              <th className="w-[34%] bg-slate-100 p-4">
                Артикулы поставщика
              </th>

              <th className="w-[12%] rounded-r-xl bg-slate-100 p-4 text-right">
                Действия
              </th>
            </tr>
          </thead>

          <tbody>
            {paginatedCampaigns.map((campaign) => (
              <CampaignRow
                key={campaign.campaignName}
                campaign={campaign}
                vendorCodes={vendorCodes}
                selected={selectedByCampaign[campaign.campaignName] ?? []}
                onChange={(vendorCodes) =>
                  updateSelected(campaign.campaignName, vendorCodes)
                }
                onDelete={() => handleDeleteCampaign(campaign.campaignName)}
              />
            ))}

            {paginatedCampaigns.length === 0 && (
              <tr>
                <td
                  colSpan={4}
                  className="rounded-2xl bg-white p-8 text-center text-slate-500"
                >
                  Рекламные кампании не найдены.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-between rounded-2xl bg-white p-5 shadow-sm">
        <div className="text-sm text-slate-600">
          Страница {page} из {totalPages}. Найдено кампаний:{" "}
          {filteredCampaigns.length}
        </div>

        <div className="flex gap-2">
          <button
            type="button"
            disabled={page <= 1}
            onClick={() => setPage((current) => Math.max(1, current - 1))}
            className="rounded-xl border border-slate-300 px-4 py-2 disabled:opacity-40"
          >
            Назад
          </button>

          <button
            type="button"
            disabled={page >= totalPages}
            onClick={() =>
              setPage((current) => Math.min(totalPages, current + 1))
            }
            className="rounded-xl border border-slate-300 px-4 py-2 disabled:opacity-40"
          >
            Вперед
          </button>
        </div>
      </div>

      <div className="sticky bottom-4 z-30 flex justify-end">
        <button
          type="button"
          onClick={handleSaveAll}
          disabled={isPending}
          className="rounded-2xl bg-slate-900 px-8 py-4 text-base font-bold text-white shadow-xl transition hover:bg-slate-800 disabled:opacity-60"
        >
          {isPending ? "Сохраняю..." : "Сохранить все связки"}
        </button>
      </div>

      </div>
  );
}

function CampaignRow({
  campaign,
  vendorCodes,
  selected,
  onChange,
  onDelete,
}: {
  campaign: Campaign;
  vendorCodes: VendorOption[];
  selected: string[];
  onChange: (vendorCodes: string[]) => void;
  onDelete: () => void;
}) {
  const wrapperRef = useRef<HTMLDivElement | null>(null);

  const [open, setOpen] = useState(false);
  const [inputValue, setInputValue] = useState(selected.join(", "));

  useEffect(() => {
    if (!open) {
      setInputValue(selected.join(", "));
    }
  }, [selected, open]);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (
        wrapperRef.current &&
        !wrapperRef.current.contains(event.target as Node)
      ) {
        setOpen(false);
      }
    }

    document.addEventListener("mousedown", handleClickOutside);

    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, []);

  const activeSearch = inputValue.split(/[,\n;]/).pop()?.trim().toLowerCase() ?? "";

  const filteredVendors = useMemo(() => {
    if (!activeSearch) return vendorCodes;

    return vendorCodes.filter((vendor) =>
      vendor.label.toLowerCase().includes(activeSearch)
    );
  }, [vendorCodes, activeSearch]);

  function toggleVendor(value: string) {
    const next = selected.includes(value)
      ? selected.filter((item) => item !== value)
      : [...selected, value];

    onChange(next);
    setOpen(true);
  }

  function selectAllFiltered() {
    onChange(
      Array.from(
        new Set([...selected, ...filteredVendors.map((vendor) => vendor.value)])
      )
    );
  }

  function clearSelected() {
    onChange([]);
    setInputValue("");
  }

  function handleInputChange(value: string) {
    setInputValue(value);
    setOpen(true);

    if (value.includes(",") || value.includes(";") || value.includes("\n")) {
      onChange(parseVendorText(value));
    }
  }

  return (
    <tr className="bg-white shadow-sm hover:bg-slate-50">
      <td className="rounded-l-2xl bg-white p-5 align-top font-semibold text-slate-900">
        {campaign.campaignName}
      </td>

      <td className="whitespace-nowrap bg-white p-5 align-top font-bold">
        {Math.round(campaign.spend).toLocaleString("ru-RU")} ₽
      </td>

      <td className="relative bg-white p-5 align-top">
        <div ref={wrapperRef} className="relative">
          <input
            value={inputValue}
            onFocus={() => setOpen(true)}
            onClick={() => setOpen(true)}
            onChange={(event) => handleInputChange(event.target.value)}
            placeholder="Выбери или вставь артикулы"
            className="w-full select-text rounded-xl border border-slate-300 bg-white px-4 py-3 pr-12 text-left outline-none transition focus:border-slate-500 focus:ring-2 focus:ring-slate-200"
          />

          <button
            type="button"
            onClick={() => setOpen((current) => !current)}
            className="absolute right-3 top-1/2 -translate-y-1/2 rounded-lg px-2 py-1 text-slate-400 hover:bg-slate-100"
          >
            ▼
          </button>

          {open && (
            <div className="absolute left-0 right-0 top-[56px] z-[9999] rounded-2xl border border-slate-200 bg-white p-3 shadow-2xl">
              <div className="mb-3 flex gap-2">
                <button
                  type="button"
                  onClick={selectAllFiltered}
                  className="rounded-lg bg-slate-100 px-3 py-1 text-xs font-medium hover:bg-slate-200"
                >
                  Выбрать все
                </button>

                <button
                  type="button"
                  onClick={clearSelected}
                  className="rounded-lg bg-red-50 px-3 py-1 text-xs font-medium text-red-600 hover:bg-red-100"
                >
                  Очистить
                </button>
              </div>

              <div className="max-h-72 overflow-y-auto rounded-xl border border-slate-100">
                {filteredVendors.map((vendor) => (
                  <label
                    key={vendor.value}
                    className="flex cursor-pointer items-center gap-2 px-3 py-2 text-sm hover:bg-slate-100"
                  >
                    <input
                      type="checkbox"
                      checked={selected.includes(vendor.value)}
                      onChange={() => toggleVendor(vendor.value)}
                    />
                    <span>{vendor.label}</span>
                  </label>
                ))}

                {filteredVendors.length === 0 && (
                  <div className="p-3 text-sm text-slate-500">
                    Артикулы не найдены.
                  </div>
                )}
              </div>

              <button
                type="button"
                onClick={() => setOpen(false)}
                className="mt-3 w-full rounded-xl bg-slate-900 px-3 py-2 text-sm font-medium text-white"
              >
                Готово
              </button>
            </div>
          )}
        </div>
      </td>

      <td className="rounded-r-2xl bg-white p-5 text-right align-top">
        <button
          type="button"
          onClick={onDelete}
          className="rounded-lg border border-red-200 px-3 py-1 text-red-600 hover:bg-red-50"
        >
          Удалить
        </button>
      </td>
    </tr>
  );
}