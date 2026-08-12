/// <reference path="./anime-torrent-provider.d.ts" />

class Provider {
    constructor() {
        this.baseUrl = "https://nyaa.si"
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

        let torrents = await this.searchTorrents(query)

        if (opts && opts.batch) {
            torrents = torrents.filter(torrent => torrent && torrent.isBatch)
        } else if (opts && opts.episodeNumber > 0) {
            torrents = torrents.filter(torrent => torrent && torrent.episodeNumber === opts.episodeNumber)
        }

        if (opts && opts.resolution) {
            const wantedResolution = String(opts.resolution).toLowerCase().replace(/p?$/i, "p")
            const resolutionMatches = torrents.filter(torrent => {
                const resolution = String((torrent && torrent.resolution) || "").toLowerCase()
                return !resolution || resolution === wantedResolution
            })

            if (resolutionMatches.length > 0) {
                torrents = resolutionMatches
            }
        }

        return torrents
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

        const isProbe = cleaned.toLowerCase() === "nyaa probe"
        const searchQuery = isProbe ? "One Piece" : cleaned
        const url = this.baseUrl + "/?f=0&c=0_0&q=" + encodeURIComponent(searchQuery) + "&s=seeders&o=desc"

        try {
            const response = await fetch(url)
            if (!response.ok) return []

            const html = response.text()
            const $ = LoadDoc(html)
            const rows = $("tbody tr")

            if (isProbe) {
                const firstRow = rows.first()
                const titleLink = firstRow.find('td[colspan="2"] a').first()
                const magnetLink = firstRow.find('a[href^="magnet:"]').first()
                const cells = firstRow.children("td")

                const title = titleLink.text().trim()
                const pagePath = titleLink.attr("href") || ""
                const magnet = (magnetLink.attr("href") || "").replace(/&amp;/g, "&")
                const size = cells.eq(3).text().trim()
                const date = cells.eq(4).text().trim()
                const seeders = cells.eq(5).text().trim()
                const leechers = cells.eq(6).text().trim()

                return [{
                    name: "NYAA PROBE | rows=" + rows.length() + " | title=" + title + " | page=" + pagePath + " | magnet=" + (magnet ? "yes" : "no") + " | size=" + size + " | date=" + date + " | seeders=" + seeders + " | leechers=" + leechers,
                    date: new Date(0).toISOString(),
                    size: this.parseSize(size),
                    formattedSize: size,
                    seeders: this.toNumber(seeders),
                    leechers: this.toNumber(leechers),
                    downloadCount: 0,
                    link: pagePath ? this.baseUrl + pagePath.replace(/#comments$/i, "") : url,
                    downloadUrl: "",
                    magnetLink: magnet,
                    infoHash: this.parseInfoHash(magnet),
                    resolution: "1080p",
                    isBatch: false,
                    episodeNumber: 1,
                    releaseGroup: "NYAA-PROBE",
                    isBestRelease: false,
                    confirmed: true,
                }]
            }

            return rows.map((index, row) => {
                const titleLink = row.find('td[colspan="2"] a').first()
                const magnetLink = row.find('a[href^="magnet:"]').first()
                const cells = row.children("td")

                const name = titleLink.text().trim()
                const pagePath = titleLink.attr("href") || ""
                const magnet = (magnetLink.attr("href") || "").replace(/&amp;/g, "&")
                const formattedSize = cells.eq(3).text().trim()

                return {
                    name: name,
                    date: this.toRFC3339(cells.eq(4).text().trim()),
                    size: this.parseSize(formattedSize),
                    formattedSize: formattedSize,
                    seeders: this.toNumber(cells.eq(5).text().trim()),
                    leechers: this.toNumber(cells.eq(6).text().trim()),
                    downloadCount: this.toNumber(cells.eq(7).text().trim()),
                    link: pagePath ? this.baseUrl + pagePath.replace(/#comments$/i, "") : magnet,
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
            }).filter(torrent => torrent.name && (torrent.magnetLink || torrent.link))
        } catch (_) {
            return []
        }
    }
    async runHtmlProbe() {
        const url = "https://example.com/"

        const response = await fetch(url, {
            headers: {
                "User-Agent": "Seanime Nyaa Torrent Provider HTML Probe",
            },
            timeout: 20,
        })

        if (!response.ok) {
            return [{
                name: "HTML probe failed: HTTP " + response.status,
                date: new Date(0).toISOString(),
                size: 0,
                formattedSize: "",
                seeders: 0,
                leechers: 0,
                downloadCount: 0,
                link: url,
                downloadUrl: "",
                magnetLink: "",
                infoHash: "",
                resolution: "",
                isBatch: false,
                episodeNumber: -1,
                releaseGroup: "",
                isBestRelease: false,
                confirmed: false,
            }]
        }

        const html = response.text()
        const $ = LoadDoc(html)

        const heading = $("h1").first().text().trim()

        const firstLink = $("a").first()
        const firstLinkText = firstLink.text().trim()
        const firstLinkHref = firstLink.attr("href") || ""

        const paragraphCount = $("p").length()

        return [{
            name:
                "HTML probe OK | h1=" +
                heading +
                " | a=" +
                firstLinkText +
                " | href=" +
                firstLinkHref +
                " | p=" +
                paragraphCount,

            date: new Date(0).toISOString(),
            size: html.length,
            formattedSize: String(html.length) + " chars",

            seeders: response.status,
            leechers: paragraphCount,
            downloadCount: 0,

            link: url,
            downloadUrl: "",
            magnetLink: "",
            infoHash: "",

            resolution: "1080p",
            isBatch: false,
            episodeNumber: 1,
            releaseGroup: "HTML-PROBE",

            isBestRelease: false,
            confirmed: true,
        }]
    }

    toAnimeTorrent(item) {
        const name = String((item && item.Name) || "")
        const magnet = String((item && item.Magnet) || "")

        return {
            name: name,
            date: this.toRFC3339(item && item.DateUploaded),

            size: this.parseSize(item && item.Size),
            formattedSize: item && item.Size
                ? String(item.Size)
                : "",

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
            (Array.isArray(media.synonyms)
                ? media.synonyms[0]
                : "") ||
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
        const match = String(magnet || "")
            .match(/btih:([A-Fa-f0-9]{32,40})/i)

        return match ? match[1] : ""
    }

    parseSize(value) {
        if (!value) return 0

        const match = String(value)
            .trim()
            .match(/^([\d.]+)\s*([KMGT]?i?B|[KMGT]B)?$/i)

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

        return Math.round(
            amount * (multipliers[unit] || 1)
        )
    }

    parseResolution(name) {
        const match = String(name || "").match(
            /(?:^|[\s[\]()._-])(2160|1440|1080|720|576|540|480)p?(?:$|[\s[\]()._-])/i
        )

        return match ? match[1] + "p" : ""
    }

    parseEpisode(name) {
        const text = String(name || "")

        if (/(?:^|[\s[\]()._-])\d{1,4}\s*-\s*\d{1,4}(?:$|[\s[\]()._-])/i.test(text)) {
            return -1
        }

        if (/(?:^|[\s[\]()._-])S\d{1,2}\s*-\s*S\d{1,2}(?:$|[\s[\]()._-])/i.test(text)) {
            return -1
        }

        const seasonEpisode = text.match(
            /(?:^|[\s[\]()._-])S\d{1,2}[\s._-]?E(\d{1,4})(?:$|[\s[\]()._-])/i
        )

        if (seasonEpisode) return Number(seasonEpisode[1])

        const explicit = text.match(
            /(?:^|[\s[\]()._-])(?:E|EP|Episode)[\s._-]?(\d{1,4})(?:$|[\s[\]()._-])/i
        )

        if (explicit) return Number(explicit[1])

        const bracketed = text.match(
            /\[(\d{1,4})]/
        )

        if (bracketed) return Number(bracketed[1])

        const dashed = text.match(
            /\s-\s(\d{1,4})(?:\s|$|[\[\]()._-])/
        )

        if (dashed) return Number(dashed[1])

        const candidates = []
        const standalonePattern = /(?:^|[\s[\]()._-])(\d{1,4})(?:$|[\s[\]()._-])/g
        let match

        while ((match = standalonePattern.exec(text)) !== null) {
            candidates.push(Number(match[1]))

            if (match[0].length === 0) {
                standalonePattern.lastIndex += 1
            }
        }

        for (let i = candidates.length - 1; i >= 0; i--) {
            const episode = candidates[i]

            if (episode === 480 || episode === 540 || episode === 576 || episode === 720 || episode === 1080 || episode === 1440 || episode === 2160) {
                continue
            }

            return episode
        }

        return -1
    }

    parseReleaseGroup(name) {
        const match = String(name || "").match(
            /^\[([^\]]+)]/
        )

        return match ? match[1] : ""
    }

    isBatch(name) {
        const text = String(name || "")

        if (/(?:^|[\s[\]()._-])(?:batch|complete|season)(?:$|[\s[\]()._-])/i.test(text)) {
            return true
        }

        return /(?:^|[\s[\]()._-])s\d{1,2}(?![\s._-]*e\d)(?:$|[\s[\]()._-])/i.test(text)
    }

    toNumber(value) {
        const number = Number(value || 0)

        return Number.isFinite(number)
            ? number
            : 0
    }

    toRFC3339(value) {
        const date = new Date(value || 0)

        if (Number.isNaN(date.getTime())) {
            return new Date(0).toISOString()
        }

        return date.toISOString()
    }
}
