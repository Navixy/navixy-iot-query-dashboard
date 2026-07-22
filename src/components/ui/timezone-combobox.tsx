import * as React from "react"
import { Check, ChevronsUpDown } from "lucide-react"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { useLocale } from "@/i18n/LocaleProvider"

// Internal region ids stay English (they are grouping keys); the visible group
// headings are translated through this slug map.
const REGION_VALUE_KEYS: Record<string, string> = {
  'Auto-Detect': 'auto_detect',
  'Americas': 'americas',
  'Europe': 'europe',
  'Asia': 'asia',
  'Africa': 'africa',
  'Australia & Pacific': 'australia_pacific',
  'Atlantic': 'atlantic',
  'Indian Ocean': 'indian_ocean',
  'Arctic': 'arctic',
  'Antarctica': 'antarctica',
  'Other': 'other',
}

interface TimezoneOption {
  value: string
  label: string
  region?: string
}

interface TimezoneComboboxProps {
  value?: string
  onValueChange: (value: string) => void
  disabled?: boolean
  browserTimezone?: string | null
}

export function TimezoneCombobox({
  value,
  onValueChange,
  disabled,
  browserTimezone,
}: TimezoneComboboxProps) {
  const [open, setOpen] = React.useState(false)
  const { t } = useLocale()

  // Get all available timezones from Intl API
  const getAllTimezones = React.useMemo(() => {
    try {
      if (typeof Intl.supportedValuesOf === 'function') {
        return Intl.supportedValuesOf('timeZone')
      }
    } catch (e) {
      // Fallback if not supported
    }
    return []
  }, [])

  // Build comprehensive timezone list with regions
  const timezones = React.useMemo(() => {
    const tzList: TimezoneOption[] = []
    
    // Add browser auto-detect first if available
    if (browserTimezone) {
      tzList.push({
        value: browserTimezone,
        label: t('settings.timezone_selector.browser_option.menu_item', { value: browserTimezone }),
        region: 'Auto-Detect'
      })
    }

    // Group timezones by region
    const regions: Record<string, string[]> = {
      'Americas': [],
      'Europe': [],
      'Asia': [],
      'Africa': [],
      'Australia & Pacific': [],
      'Atlantic': [],
      'Indian Ocean': [],
      'Arctic': [],
      'Antarctica': [],
      'Other': []
    }

    const tzArray = getAllTimezones.length > 0 ? getAllTimezones : getFallbackTimezones()
    
    tzArray.forEach(tz => {
      // Skip if it's the browser timezone (already added)
      if (tz === browserTimezone) return
      
      let region = 'Other'
      if (tz.startsWith('America/')) {
        region = 'Americas'
      } else if (tz.startsWith('Europe/')) {
        region = 'Europe'
      } else if (tz.startsWith('Asia/')) {
        region = 'Asia'
      } else if (tz.startsWith('Africa/')) {
        region = 'Africa'
      } else if (tz.startsWith('Australia/') || tz.startsWith('Pacific/')) {
        region = 'Australia & Pacific'
      } else if (tz.startsWith('Atlantic/')) {
        region = 'Atlantic'
      } else if (tz.startsWith('Indian/')) {
        region = 'Indian Ocean'
      } else if (tz.startsWith('Arctic/')) {
        region = 'Arctic'
      } else if (tz.startsWith('Antarctica/')) {
        region = 'Antarctica'
      } else if (tz === 'UTC' || tz === 'GMT') {
        region = 'Other'
      }
      
      regions[region].push(tz)
    })

    // Add timezones grouped by region
    Object.entries(regions).forEach(([regionName, tzs]) => {
      if (tzs.length === 0) return
      
      tzs.sort().forEach(tz => {
        const label = formatTimezoneLabel(tz)
        tzList.push({
          value: tz,
          label,
          region: regionName
        })
      })
    })

    return tzList
  }, [getAllTimezones, browserTimezone, t])

  const selectedTimezone = timezones.find(tz => tz.value === value)

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="secondary"
          role="combobox"
          aria-expanded={open}
          className="w-full justify-between text-sm h-10 font-normal bg-background hover:bg-accent hover:text-accent-foreground cursor-pointer border border-input"
          disabled={disabled}
        >
          {selectedTimezone ? (
            <span className="truncate text-left flex-1">{selectedTimezone.label}</span>
          ) : (
            <span className="text-muted-foreground">{t('settings.timezone_selector.placeholder.instruction')}</span>
          )}
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[400px] p-0" align="start">
        <Command>
          <CommandInput placeholder={t('settings.timezone_selector.search_input.placeholder.instruction')} />
          <CommandList className="max-h-[400px]">
            <CommandEmpty>{t('settings.timezone_selector.results_list.paragraph.empty')}</CommandEmpty>
            {Object.entries(
              timezones.reduce((acc, tz) => {
                const region = tz.region || 'Other'
                if (!acc[region]) acc[region] = []
                acc[region].push(tz)
                return acc
              }, {} as Record<string, TimezoneOption[]>)
            )
              .sort(([a], [b]) => {
                // Put Auto-Detect first, then alphabetical
                if (a === 'Auto-Detect') return -1
                if (b === 'Auto-Detect') return 1
                return a.localeCompare(b)
              })
              .map(([region, tzs]) => (
                <CommandGroup
                  key={region}
                  heading={t(`settings.timezone_selector.region_values.${REGION_VALUE_KEYS[region] ?? 'other'}`)}
                >
                  {tzs.map((tz) => (
                    <CommandItem
                      key={tz.value}
                      value={`${tz.value} ${tz.label}`}
                      onSelect={() => {
                        onValueChange(tz.value)
                        setOpen(false)
                      }}
                    >
                      <Check
                        className={cn(
                          "mr-2 h-4 w-4",
                          value === tz.value ? "opacity-100" : "opacity-0"
                        )}
                      />
                      {tz.label}
                    </CommandItem>
                  ))}
                </CommandGroup>
              ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

function formatTimezoneLabel(tz: string): string {
  // Format timezone names to be more readable
  const parts = tz.split('/')
  if (parts.length === 2) {
    const [region, city] = parts
    const cityFormatted = city.replace(/_/g, ' ')
    return `${region}/${cityFormatted}`
  }
  return tz
}

function getFallbackTimezones(): string[] {
  // Comprehensive fallback list if Intl.supportedValuesOf is not available
  // This includes most common timezones similar to OS timezone selectors
  return [
    'UTC',
    // Americas - North America
    'America/New_York',
    'America/Chicago',
    'America/Denver',
    'America/Phoenix',
    'America/Los_Angeles',
    'America/Anchorage',
    'America/Adak',
    'America/Toronto',
    'America/Vancouver',
    'America/Winnipeg',
    'America/Edmonton',
    'America/Regina',
    'America/Moncton',
    'America/Halifax',
    'America/St_Johns',
    'America/Whitehorse',
    'America/Yellowknife',
    'America/Inuvik',
    'America/Iqaluit',
    // Americas - Central America & Caribbean
    'America/Mexico_City',
    'America/Monterrey',
    'America/Tijuana',
    'America/Cancun',
    'America/Merida',
    'America/Guatemala',
    'America/Belize',
    'America/El_Salvador',
    'America/Managua',
    'America/Costa_Rica',
    'America/Panama',
    'America/Havana',
    'America/Jamaica',
    'America/Port-au-Prince',
    'America/Santo_Domingo',
    'America/Puerto_Rico',
    'America/Caracas',
    // Americas - South America
    'America/Bogota',
    'America/Lima',
    'America/La_Paz',
    'America/Asuncion',
    'America/Santiago',
    'America/Montevideo',
    'America/Buenos_Aires',
    'America/Sao_Paulo',
    'America/Fortaleza',
    'America/Recife',
    'America/Manaus',
    'America/Belem',
    'America/Cayenne',
    'America/Paramaribo',
    'America/Georgetown',
    // Europe
    'Europe/London',
    'Europe/Dublin',
    'Europe/Lisbon',
    'Europe/Madrid',
    'Europe/Paris',
    'Europe/Brussels',
    'Europe/Amsterdam',
    'Europe/Berlin',
    'Europe/Rome',
    'Europe/Vienna',
    'Europe/Prague',
    'Europe/Warsaw',
    'Europe/Budapest',
    'Europe/Bucharest',
    'Europe/Sofia',
    'Europe/Athens',
    'Europe/Helsinki',
    'Europe/Stockholm',
    'Europe/Oslo',
    'Europe/Copenhagen',
    'Europe/Riga',
    'Europe/Tallinn',
    'Europe/Vilnius',
    'Europe/Kiev',
    'Europe/Minsk',
    'Europe/Moscow',
    'Europe/Volgograd',
    'Europe/Kaliningrad',
    'Europe/Istanbul',
    'Europe/Zagreb',
    'Europe/Belgrade',
    'Europe/Sarajevo',
    'Europe/Skopje',
    'Europe/Tirane',
    'Europe/Zurich',
    'Europe/Luxembourg',
    'Europe/Monaco',
    'Europe/Malta',
    'Europe/Nicosia',
    // Asia
    'Asia/Dubai',
    'Asia/Kuwait',
    'Asia/Bahrain',
    'Asia/Qatar',
    'Asia/Riyadh',
    'Asia/Baghdad',
    'Asia/Tehran',
    'Asia/Karachi',
    'Asia/Kolkata',
    'Asia/Colombo',
    'Asia/Dhaka',
    'Asia/Kathmandu',
    'Asia/Thimphu',
    'Asia/Yangon',
    'Asia/Bangkok',
    'Asia/Ho_Chi_Minh',
    'Asia/Phnom_Penh',
    'Asia/Vientiane',
    'Asia/Jakarta',
    'Asia/Makassar',
    'Asia/Jayapura',
    'Asia/Singapore',
    'Asia/Kuala_Lumpur',
    'Asia/Manila',
    'Asia/Hong_Kong',
    'Asia/Macau',
    'Asia/Shanghai',
    'Asia/Taipei',
    'Asia/Seoul',
    'Asia/Tokyo',
    'Asia/Ulaanbaatar',
    'Asia/Vladivostok',
    'Asia/Yakutsk',
    'Asia/Irkutsk',
    'Asia/Krasnoyarsk',
    'Asia/Novosibirsk',
    'Asia/Omsk',
    'Asia/Yekaterinburg',
    'Asia/Tashkent',
    'Asia/Almaty',
    'Asia/Bishkek',
    'Asia/Dushanbe',
    'Asia/Ashgabat',
    'Asia/Baku',
    'Asia/Yerevan',
    'Asia/Tbilisi',
    'Asia/Jerusalem',
    'Asia/Beirut',
    'Asia/Damascus',
    'Asia/Amman',
    // Africa
    'Africa/Cairo',
    'Africa/Johannesburg',
    'Africa/Casablanca',
    'Africa/Algiers',
    'Africa/Tunis',
    'Africa/Tripoli',
    'Africa/Lagos',
    'Africa/Nairobi',
    'Africa/Addis_Ababa',
    'Africa/Dar_es_Salaam',
    'Africa/Kampala',
    'Africa/Khartoum',
    'Africa/Maputo',
    'Africa/Harare',
    'Africa/Lusaka',
    'Africa/Gaborone',
    'Africa/Windhoek',
    'Africa/Accra',
    'Africa/Abidjan',
    'Africa/Dakar',
    'Africa/Douala',
    'Africa/Kinshasa',
    'Africa/Lubumbashi',
    // Australia & Pacific
    'Australia/Sydney',
    'Australia/Melbourne',
    'Australia/Brisbane',
    'Australia/Perth',
    'Australia/Adelaide',
    'Australia/Darwin',
    'Australia/Hobart',
    'Pacific/Auckland',
    'Pacific/Chatham',
    'Pacific/Fiji',
    'Pacific/Guam',
    'Pacific/Honolulu',
    'Pacific/Port_Moresby',
    'Pacific/Apia',
    'Pacific/Tongatapu',
    'Pacific/Noumea',
    'Pacific/Norfolk',
    'Pacific/Palau',
    'Pacific/Majuro',
    'Pacific/Tarawa',
    'Pacific/Enderbury',
    'Pacific/Fakaofo',
    // Atlantic
    'Atlantic/Azores',
    'Atlantic/Canary',
    'Atlantic/Madeira',
    'Atlantic/Reykjavik',
    'Atlantic/Faroe',
    'Atlantic/Bermuda',
    'Atlantic/Cape_Verde',
    // Indian Ocean
    'Indian/Mauritius',
    'Indian/Reunion',
    'Indian/Maldives',
    'Indian/Seychelles',
    'Indian/Comoro',
    'Indian/Mahe',
    'Indian/Chagos',
    'Indian/Cocos',
    'Indian/Christmas',
    'Indian/Kerguelen',
    'Indian/Maldives',
    // Arctic & Antarctica
    'Arctic/Longyearbyen',
    'Antarctica/McMurdo',
    'Antarctica/Davis',
    'Antarctica/Mawson',
  ]
}

