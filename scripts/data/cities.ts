/**
 * Real-world city/country pairs backing the large-scale seed data generator
 * (`scripts/generate-large-seed-data.ts`). Facts (city/country names), not
 * curated content — descriptions/tags/prices are all derived deterministically
 * from `src/domain/geography.ts`'s per-country profile, not authored per city.
 *
 * Deliberately excludes the app's 6 hand-curated original destinations
 * (Lisbon, Kyoto, Tulum, Reykjavik, Cape Town, Barcelona) — those and their
 * fixtures stay untouched (`supabase/migrations/0002_seed_data.sql`).
 * City names are kept globally unique across this whole list (no two
 * countries share a city name). `getDestinationByName`
 * (`src/repositories/destinations.ts`) is now country-aware (resolved
 * 2026-09-18) — it accepts an optional `country` to disambiguate a shared
 * city name, parsed from the trip's free-text destination requirement by
 * `parseDestinationQuery` (`src/domain/destination-query.ts`) — so a future
 * duplicate name wouldn't break resolution outright the way it would have
 * before, as long as the user's phrasing (or the model's extraction)
 * includes the country. Kept globally unique here anyway: it's still the
 * simpler invariant, and nothing about the real-world city list actually
 * requires reusing a name. `scripts/_check-cities.ts` (throwaway, not
 * committed) verified this list has no duplicate names and no country
 * missing from `COUNTRY_PROFILES`.
 *
 * Every country key here must exist in `COUNTRY_PROFILES`
 * (`src/domain/geography.ts`) — the generator throws immediately if not.
 */

export const CITIES_BY_COUNTRY: Record<string, string[]> = {
  "United States": [
    "New York City", "Los Angeles", "Chicago", "San Francisco", "Miami",
    "Boston", "Seattle", "Las Vegas", "New Orleans", "Austin",
    "Denver", "Nashville", "Portland", "San Diego", "Honolulu",
    "Charleston", "Savannah", "Santa Fe", "Sedona", "Aspen",
    "Napa", "Key West", "Anchorage", "Palm Springs", "Asheville",
    "Philadelphia", "Washington D.C.", "Houston", "Dallas", "Phoenix",
    "Atlanta", "Minneapolis", "Detroit", "Baltimore", "San Antonio",
    "Salt Lake City", "Memphis", "Kansas City", "St. Louis", "Milwaukee",
    "Pittsburgh", "Cincinnati", "Cleveland", "Columbus", "Tampa",
  ],
  Canada: [
    "Toronto", "Vancouver", "Montreal", "Quebec City", "Banff",
    "Ottawa", "Calgary", "Victoria", "Whistler", "Halifax",
    "Winnipeg", "Edmonton", "St. John's", "Niagara Falls", "Jasper",
  ],
  Mexico: [
    "Mexico City", "Cancun", "Oaxaca", "Puerto Vallarta", "Guadalajara",
    "San Miguel de Allende", "Merida", "Playa del Carmen", "Cabo San Lucas", "Guanajuato",
    "Tijuana", "Monterrey", "Puebla", "Isla Holbox", "Sayulita",
  ],

  // Central America / Caribbean
  Guatemala: ["Antigua Guatemala", "Flores", "Lake Atitlan"],
  Belize: ["Belize City", "Caye Caulker", "Placencia"],
  "Costa Rica": ["San Jose", "Monteverde", "Tamarindo", "La Fortuna", "Manuel Antonio", "Puerto Viejo"],
  Panama: ["Panama City", "Bocas del Toro", "Boquete", "San Blas Islands"],
  Honduras: ["Roatan", "Tegucigalpa", "Copan"],
  "El Salvador": ["San Salvador", "El Tunco"],
  Nicaragua: ["Ometepe Island", "San Juan del Sur"],
  Cuba: ["Havana", "Trinidad", "Varadero", "Cienfuegos"],
  Jamaica: ["Montego Bay", "Ocho Rios", "Negril", "Port Antonio"],
  "Dominican Republic": ["Punta Cana", "Santo Domingo", "Puerto Plata", "Samana"],
  "Puerto Rico": ["San Juan", "Vieques", "Rincon", "Culebra"],
  "The Bahamas": ["Nassau", "Exuma", "Grand Bahama"],
  Barbados: ["Bridgetown"],
  "Trinidad and Tobago": ["Port of Spain", "Scarborough"],

  // South America
  Colombia: ["Bogota", "Cartagena", "Medellin", "Santa Marta", "Cali", "San Andres", "Villa de Leyva", "Guatape"],
  Venezuela: ["Caracas", "Canaima", "Isla Margarita"],
  Ecuador: ["Quito", "Cuenca", "Guayaquil", "Baños", "Galapagos Islands"],
  Peru: ["Lima", "Cusco", "Arequipa", "Iquitos", "Puno", "Nazca", "Mancora"],
  Bolivia: ["La Paz", "Sucre", "Uyuni"],
  Chile: ["Santiago", "Valparaiso", "San Pedro de Atacama", "Puerto Natales", "Punta Arenas", "Easter Island"],
  Argentina: ["Buenos Aires", "Mendoza", "Bariloche", "Ushuaia", "Salta", "Cordoba", "Iguazu Falls", "El Calafate"],
  Uruguay: ["Montevideo", "Punta del Este", "Colonia del Sacramento"],
  Paraguay: ["Asuncion", "Ciudad del Este"],
  Brazil: [
    "Rio de Janeiro", "Sao Paulo", "Salvador", "Florianopolis", "Recife",
    "Fortaleza", "Manaus", "Brasilia", "Foz do Iguacu", "Buzios",
    "Ouro Preto", "Paraty", "Belo Horizonte",
  ],
  Guyana: ["Georgetown"],
  Suriname: ["Paramaribo"],

  // Western / Northern Europe
  "United Kingdom": [
    "London", "Edinburgh", "Manchester", "Bath", "Liverpool",
    "Glasgow", "Oxford", "Cambridge", "Bristol", "Inverness",
    "Windsor", "Lake District", "St Andrews",
  ],
  Ireland: ["Dublin", "Galway", "Cork", "Killarney", "Doolin", "Kilkenny"],
  France: [
    "Paris", "Nice", "Lyon", "Marseille", "Bordeaux",
    "Strasbourg", "Annecy", "Avignon", "Cannes", "Chamonix",
    "Versailles", "Colmar", "Toulouse", "Mont Saint-Michel",
  ],
  Germany: [
    "Berlin", "Munich", "Hamburg", "Frankfurt", "Cologne",
    "Dresden", "Heidelberg", "Nuremberg", "Stuttgart", "Leipzig",
    "Rothenburg ob der Tauber", "Baden-Baden", "Bremen",
  ],
  Netherlands: ["Amsterdam", "Rotterdam", "Utrecht", "The Hague", "Maastricht", "Delft", "Giethoorn"],
  Belgium: ["Brussels", "Bruges", "Ghent"],
  Luxembourg: ["Luxembourg City"],
  Switzerland: ["Zurich", "Geneva", "Interlaken", "Lucerne", "Zermatt", "Bern", "Grindelwald"],
  Austria: ["Vienna", "Salzburg", "Innsbruck", "Hallstatt", "Graz"],
  Denmark: ["Copenhagen", "Aarhus", "Odense", "Skagen"],
  Norway: ["Oslo", "Bergen", "Tromso", "Alesund", "Flam", "Lofoten Islands"],
  Sweden: ["Stockholm", "Gothenburg", "Malmo", "Kiruna", "Uppsala"],
  Finland: ["Helsinki", "Rovaniemi", "Turku", "Tampere"],
  Iceland: ["Akureyri", "Vik", "Husavik"],

  // Southern Europe
  Spain: [
    "Madrid", "Seville", "Valencia", "Granada", "Bilbao",
    "San Sebastian", "Malaga", "Toledo", "Ibiza Town", "Palma de Mallorca",
    "Salamanca", "Ronda", "Cadiz",
  ],
  Portugal: ["Porto", "Sintra", "Faro", "Madeira", "Coimbra", "Nazare"],
  Italy: [
    "Rome", "Florence", "Venice", "Milan", "Naples",
    "Bologna", "Verona", "Siena", "Amalfi", "Cinque Terre",
    "Palermo", "Turin", "Cortina d'Ampezzo", "Pisa", "Lake Como",
  ],
  Greece: ["Athens", "Santorini", "Mykonos", "Crete", "Rhodes", "Thessaloniki", "Naxos", "Paros"],
  Malta: ["Valletta"],
  Cyprus: ["Nicosia", "Limassol"],
  Croatia: ["Dubrovnik", "Split", "Zagreb", "Hvar", "Zadar", "Rovinj"],
  Slovenia: ["Ljubljana", "Lake Bled"],
  Montenegro: ["Kotor", "Budva"],

  // Central / Eastern Europe, Caucasus, Russia
  Poland: ["Warsaw", "Krakow", "Gdansk", "Wroclaw", "Poznan", "Zakopane", "Torun"],
  "Czech Republic": ["Prague", "Cesky Krumlov", "Brno", "Karlovy Vary"],
  Slovakia: ["Bratislava", "Tatra Mountains"],
  Hungary: ["Budapest", "Eger", "Debrecen", "Lake Balaton"],
  Romania: ["Bucharest", "Brasov", "Cluj-Napoca", "Sibiu"],
  Bulgaria: ["Sofia", "Plovdiv", "Varna", "Nessebar"],
  Serbia: ["Belgrade", "Novi Sad", "Nis"],
  Albania: ["Tirana", "Saranda"],
  "North Macedonia": ["Skopje"],
  "Bosnia and Herzegovina": ["Sarajevo", "Mostar"],
  Estonia: ["Tallinn", "Tartu"],
  Latvia: ["Riga"],
  Lithuania: ["Vilnius", "Kaunas"],
  Ukraine: ["Kyiv", "Lviv", "Odesa"],
  Belarus: ["Minsk"],
  Moldova: ["Chisinau"],
  Georgia: ["Tbilisi", "Batumi", "Kazbegi"],
  Armenia: ["Yerevan", "Dilijan"],
  Azerbaijan: ["Baku", "Sheki"],
  Russia: ["Moscow", "Saint Petersburg", "Kazan", "Sochi", "Vladivostok", "Yekaterinburg", "Novosibirsk", "Suzdal"],

  // Middle East / North Africa
  Turkey: ["Istanbul", "Cappadocia", "Antalya", "Izmir", "Bodrum", "Pamukkale", "Ephesus", "Fethiye"],
  Israel: ["Tel Aviv", "Jerusalem", "Eilat"],
  Jordan: ["Amman", "Petra", "Wadi Rum"],
  Lebanon: ["Beirut", "Byblos"],
  "United Arab Emirates": ["Dubai", "Abu Dhabi", "Sharjah", "Ras Al Khaimah"],
  Qatar: ["Doha"],
  "Saudi Arabia": ["Riyadh", "Jeddah", "AlUla", "Abha"],
  Oman: ["Muscat", "Salalah"],
  Bahrain: ["Manama"],
  Kuwait: ["Kuwait City"],
  Egypt: ["Cairo", "Luxor", "Aswan", "Sharm El Sheikh", "Alexandria", "Siwa Oasis"],
  Iran: ["Tehran", "Isfahan", "Shiraz"],

  // Africa (sub-Saharan)
  Morocco: ["Marrakech", "Fes", "Chefchaouen", "Essaouira", "Casablanca", "Agadir", "Merzouga"],
  Tunisia: ["Tunis", "Sousse", "Djerba"],
  Algeria: ["Algiers", "Oran"],
  Senegal: ["Dakar", "Saint-Louis"],
  "Ivory Coast": ["Abidjan", "Grand-Bassam"],
  Ghana: ["Accra", "Cape Coast"],
  Nigeria: ["Lagos", "Abuja", "Calabar"],
  Cameroon: ["Douala", "Yaounde"],
  Ethiopia: ["Addis Ababa", "Lalibela"],
  Kenya: ["Nairobi", "Mombasa", "Maasai Mara", "Diani Beach"],
  Tanzania: ["Zanzibar", "Arusha", "Dar es Salaam", "Serengeti"],
  Uganda: ["Kampala", "Entebbe"],
  Rwanda: ["Kigali"],
  Zambia: ["Livingstone"],
  Zimbabwe: ["Victoria Falls", "Harare"],
  Botswana: ["Gaborone", "Maun", "Okavango Delta"],
  Namibia: ["Windhoek", "Swakopmund", "Sossusvlei"],
  "South Africa": ["Johannesburg", "Durban", "Stellenbosch", "Kruger", "Port Elizabeth", "Franschhoek", "Sun City"],
  Mozambique: ["Maputo", "Vilanculos"],
  Madagascar: ["Antananarivo", "Nosy Be"],
  Mauritius: ["Port Louis", "Grand Baie"],
  Seychelles: ["Mahe"],

  // South Asia
  India: [
    "New Delhi", "Mumbai", "Jaipur", "Agra", "Goa",
    "Udaipur", "Varanasi", "Kerala Backwaters", "Rishikesh", "Amritsar",
    "Jodhpur", "Darjeeling", "Hampi", "Mysore", "Pondicherry",
    "Shimla", "Leh", "Andaman Islands",
  ],
  Pakistan: ["Lahore", "Karachi", "Islamabad", "Hunza Valley"],
  Bangladesh: ["Dhaka", "Cox's Bazar", "Sylhet"],
  "Sri Lanka": ["Colombo", "Kandy", "Ella", "Galle"],
  Nepal: ["Kathmandu", "Pokhara", "Chitwan"],
  Bhutan: ["Thimphu"],
  Maldives: ["Male", "Maafushi"],

  // Central Asia
  Kazakhstan: ["Almaty", "Astana"],
  Uzbekistan: ["Tashkent", "Samarkand", "Bukhara"],
  Kyrgyzstan: ["Bishkek"],
  Mongolia: ["Ulaanbaatar"],

  // East Asia
  Japan: [
    "Tokyo", "Osaka", "Sapporo", "Hiroshima", "Nagoya",
    "Nara", "Fukuoka", "Okinawa", "Kanazawa", "Hakone",
    "Yokohama", "Kobe", "Nikko",
  ],
  "South Korea": ["Seoul", "Busan", "Jeju Island", "Gyeongju", "Incheon", "Jeonju"],
  China: [
    "Beijing", "Shanghai", "Xi'an", "Chengdu", "Guilin",
    "Guangzhou", "Hangzhou", "Suzhou", "Lijiang", "Zhangjiajie",
    "Chongqing", "Kunming", "Harbin", "Qingdao", "Lhasa",
    "Datong", "Pingyao", "Dali",
  ],
  Taiwan: ["Taipei", "Kaohsiung", "Tainan", "Hualien", "Sun Moon Lake"],
  "Hong Kong": ["Hong Kong"],
  Macau: ["Macau"],

  // Southeast Asia
  Thailand: ["Bangkok", "Chiang Mai", "Phuket", "Krabi", "Koh Samui", "Ayutthaya", "Pai", "Koh Phi Phi"],
  Vietnam: ["Hanoi", "Ho Chi Minh City", "Hoi An", "Ha Long Bay", "Da Nang", "Sapa", "Phu Quoc"],
  Cambodia: ["Siem Reap", "Phnom Penh"],
  Laos: ["Luang Prabang", "Vientiane"],
  Myanmar: ["Yangon", "Bagan"],
  Malaysia: ["Kuala Lumpur", "Penang", "Langkawi", "Malacca", "Kota Kinabalu", "Cameron Highlands"],
  Singapore: ["Singapore"],
  Indonesia: [
    "Bali", "Jakarta", "Yogyakarta", "Lombok", "Komodo Island",
    "Ubud", "Bandung", "Raja Ampat", "Nusa Penida", "Labuan Bajo",
  ],
  Philippines: ["Manila", "Cebu", "Palawan", "Boracay", "Siargao", "Bohol"],
  Brunei: ["Bandar Seri Begawan"],

  // Oceania
  Australia: [
    "Sydney", "Melbourne", "Brisbane", "Perth", "Cairns",
    "Gold Coast", "Adelaide", "Hobart", "Uluru", "Byron Bay", "Darwin",
  ],
  "New Zealand": ["Auckland", "Queenstown", "Wellington", "Rotorua", "Christchurch", "Napier", "Nelson"],
  Fiji: ["Nadi", "Denarau Island", "Mamanuca Islands"],
  "Papua New Guinea": ["Port Moresby"],
  Samoa: ["Apia"],
  "French Polynesia": ["Bora Bora", "Papeete"],
};
