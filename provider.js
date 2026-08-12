/// <reference path="./anime-torrent-provider.d.ts" />

class Provider {
    constructor() {
        this.api = "https://torrent-search-api-livid.vercel.app/api/nyaasi/"
    }

    getSettings() {
        return {
            canSmartSearch: true,
            smartSearchFilters: ["episodeNumber", "batch", "resolution", "query"],
            supportsAdult: false,
            type: "main",
        }
    }

    async search(opts) {
        const query = this.cleanQuery(opts && opts.query)
        if (!query) return []

        return this.searchTorrents(query)
    }

    async smartSearch(opts) {
        let query = this.cleanQuery(opts && opts.query)

        if (!query) {
            query = this.getBestTitle(opts && opts.media)
        }

        if (!query) return []

        if (opts && opts.batch) {
            query += " batch"
        } else if (opts && opts.episodeNumber > 0) {
            query += " " + String(opts.episodeNumber).padStart(2, "0")
        }

        if (opts && opts.resolution) {
            query += " " + String(opts.resolution).replace(/p$/i, "")
        }

        return this.searchTorrents(query)
    }

    async getTorrentInfoHash(torrent) {
        return (torrent && torrent.infoHash) || ""
    }

    async getTorrentMagnetLink(torrent) {
        return (torrent && torrent.magnetLink) || (torrent && torrent.link) || ""
    }

    async getLatest() {
        return []
    }

    async searchTorrents(query) {
        const cleaned = this.cleanQuery(query)
        if (!cleaned) return []

        try {
            const response = await fetch(this.api + encodeURIComponent(cleaned))
            if (!response.ok) return []

            const data = await response.json()
            if (!Array.isArray(data)) return []

            return data.map(item => this.toAnimeTorrent(item)).filter(torrent => torrent.name)
        } catch (_) {
            return []
        }
    }

    toAnimeTorrent(item) {
        const name = String((item && item.Name) || "")
        const magnet = String((item && item.Magnet) || "")

        return {
            name: name,
            date: this.toRFC3339(item && item.DateUploaded),
            size: this.parseSize(item && item.Size),
            formattedSize: item && item.Size ? String(item.Size) : "",

            seeders: this.toNumber(item && item.Seeders),
            leechers: this.toNumber(item && item.Leechers),
            downloadCount: this.toNumber(item && item.Downloads),

            link: magnet,
            downloadUrl: "",
            magnetLink: magnet,
            infoHash: this.parseInfoHash(magnet),

            resolution: this.parseResolution(name),
            isBatch: this.isBatch(name),
            episodeNumber: this.parseEpisode(name),
            releaseGroup: this.parseReleaseGroup(name),

            isBestRelease: false,
            confirmed: false,
        }
    }

    getBestTitle(media) {
        if (!media) return ""

        return this.cleanQuery(
            media.englishTitle ||
            media.romajiTitle ||
            (Array.isArray(media.synonyms) && media.synonyms[0]) ||
            ""
        )
    }

    cleanQuery(value) {
        return String(value || "")
            .replace(/[^\w\s-]/g, " ")
            .replace(/\s+/g, " ")
            .trim()
    }

    parseInfoHash(magnet) {
        const match = String(magnet || "").match(/btih:([A-Fa-f0-9]{32,40})/i)
        return match ? match[1] : ""
    }

    parseSize(value) {
        if (!value) return 0

        const match = String(value).trim().match(/^([\d.]+)\s*([KMGT]?i?B|[KMGT]B)?$/i)
        if (!match) return 0

        const amount = Number(match[1])
        const unit = (match[2] || "B").toUpperCase()

        if (!Number.isFinite(amount)) return 0

        const multipliers = {
            B: 1,
            KB: 1000,
            MB: 1000 ** 2,
            GB: 1000 ** 3,
            TB: 1000 ** 4,
            KIB: 1024,
            MIB: 1024 ** 2,
            GIB: 1024 ** 3,
            TIB: 1024 ** 4,
        }

        return Math.round(amount * (multipliers[unit] || 1))
    }

    parseResolution(name) {
        const match = String(name || "").match(/(?:^|[\s[\]()._-])(2160|1440|1080|720|576|540|480)p?(?:$|[\s[\]()._-])/i)
        return match ? match[1] + "p" : ""
    }

    parseEpisode(name) {
        const text = String(name || "")

        const explicit = text.match(/(?:^|[\s[\]()._-])(?:E|EP|Episode)[\s._-]?(\d{1,4})(?:$|[\s[\]()._-])/i)
        if (explicit) return Number(explicit[1])

        const bracketed = text.match(/\[(\d{1,3})]/)
        if (bracketed) return Number(bracketed[1])

        const dashed = text.match(/\s-\s(\d{1,3})(?:\s|$|[\[\]()._-])/)
        if (dashed) return Number(dashed[1])

        return -1
    }

    parseReleaseGroup(name) {
        const match = String(name || "").match(/^\[([^\]]+)]/)
        return match ? match[1] : ""
    }

    isBatch(name) {
        return /\b(?:batch|complete|season|s\d{1,2}|全集)\b/i.test(String(name || ""))
    }

    toNumber(value) {
        const number = Number(value || 0)
        return Number.isFinite(number) ? number : 0
    }

    toRFC3339(value) {
        const date = new Date(value || 0)

        if (Number.isNaN(date.getTime())) {
            return new Date(0).toISOString()
        }

        return date.toISOString()
    }
}