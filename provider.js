/// <reference path="./anime-torrent-provider.d.ts" />

const NEKOBT_API_KEY = "eyJhbGciOiJIUzI1NiJ9.eyJ1c3IiOiIxMzAyMjgwOTAyMjk5OSIsInZlciI6MiwidHlwIjoxLCJpYXQiOjE3ODY2MTQ3NjcsImV4cCI6MTgxODE1MDc2N30.bsc6muXf09xdrPKsIROmafUNFEFKlf06S8UZC547_Dw"

class Provider {
    constructor() {
        this.baseUrl = "https://nekobt.to"
        this.apiBaseUrl = this.baseUrl + "/api/v1"
        this.authenticated = null
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
        const query = this.cleanQuery(opts && opts.query) || this.getBestTitle(opts && opts.media)
        if (!query) return []

        return this.searchTorrents({
            query: query,
            limit: 100,
            sort_by: "best",
        }, {
            confirmed: false,
            episodesById: {},
        })
    }

    async smartSearch(opts) {
        const media = opts && opts.media
        const manualQuery = this.cleanQuery(opts && opts.query)
        const titleQuery = this.getBestTitle(media)
        const query = manualQuery || titleQuery
        if (!query) return []

        const requestedEpisode = this.toPositiveInteger(opts && opts.episodeNumber, -1)
        const requestedResolution = this.normalizeResolution(opts && opts.resolution)
        const wantsBatch = Boolean(opts && opts.batch)

        const mediaMatch = await this.resolveMedia(media, titleQuery || query)
        const mediaDetails = mediaMatch
            ? await this.apiGet("/media/" + encodeURIComponent(String(mediaMatch.id)))
            : null
        const episodes = mediaDetails && Array.isArray(mediaDetails.episodes)
            ? mediaDetails.episodes
            : []
        const selectedEpisode = requestedEpisode > 0
            ? this.findEpisode(episodes, requestedEpisode, media && media.absoluteSeasonOffset)
            : null
        const episodesById = this.indexEpisodes(episodes)

        const params = {
            limit: 100,
            sort_by: "seeders",
        }

        if (mediaMatch) {
            params.media_id = String(mediaMatch.id)
        } else {
            params.query = this.buildSmartQuery(query, opts)
        }

        if (wantsBatch) {
            params.batch = true
        } else if (requestedEpisode > 0) {
            params.batch = false
        }

        if (selectedEpisode) {
            params.episode_ids = String(selectedEpisode.id)
        }

        const context = {
            confirmed: Boolean(mediaMatch),
            mediaId: mediaMatch ? String(mediaMatch.id) : "",
            selectedEpisodeId: selectedEpisode ? String(selectedEpisode.id) : "",
            episodeFilterApplied: Boolean(selectedEpisode),
            structuredEpisodeResolved: Boolean(selectedEpisode),
            requestedSeason: selectedEpisode
                ? this.toPositiveInteger(selectedEpisode.season, 0)
                : 0,
            requestedEpisode: requestedEpisode,
            requestedAbsoluteEpisode: this.getAbsoluteEpisode(requestedEpisode, media && media.absoluteSeasonOffset),
            requestedResolution: requestedResolution,
            episodesById: episodesById,
        }

        let torrents = await this.searchTorrents(params, context)

        if (selectedEpisode && torrents.length === 0) {
            // Some NekoBT torrents belong to the correct media but have no
            // media_episode_ids. Fall back once and let local parsing decide.
            delete params.episode_ids
            context.selectedEpisodeId = ""
            context.episodeFilterApplied = false
            context.confirmed = false
            torrents = await this.searchTorrents(params, context)
        }

        if (wantsBatch) {
            torrents = torrents.filter(torrent => torrent && torrent.isBatch === true)
        } else if (requestedEpisode > 0) {
            const singleTorrents = torrents.filter(torrent => torrent && torrent.isBatch !== true)

            if (context.episodeFilterApplied) {
                // NekoBT already restricted the response using the structured episode ID.
                // Prefer single releases, but keep structured multi-episode results as fallback.
                if (singleTorrents.length > 0) torrents = singleTorrents
            } else {
                const matchingEpisodes = singleTorrents.filter(torrent => {
                    if (context.requestedSeason > 0) {
                        return torrent.episodeNumber === context.requestedAbsoluteEpisode
                    }

                    return torrent.episodeNumber === requestedEpisode ||
                        torrent.episodeNumber === context.requestedAbsoluteEpisode
                })
                const unknownEpisodes = singleTorrents.filter(torrent => torrent.episodeNumber < 1)

                torrents = matchingEpisodes.length > 0
                    ? matchingEpisodes
                    : context.structuredEpisodeResolved
                        ? []
                        : unknownEpisodes
            }
        }

        if (requestedResolution) {
            const matching = torrents.filter(torrent => torrent && torrent.resolution === requestedResolution)
            const unknown = torrents.filter(torrent => torrent && !torrent.resolution)

            if (matching.length > 0) {
                torrents = matching.concat(unknown)
            }
        }

        return this.sortTorrents(torrents, context)
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

    async searchTorrents(params, context) {
        const data = await this.apiGet("/torrents/search", params)
        const items = data && Array.isArray(data.results) ? data.results : []
        const torrents = []

        for (let i = 0; i < items.length; i++) {
            try {
                const torrent = this.mapNekoTorrent(items[i], context || {})
                if (torrent && torrent.name && (torrent.magnetLink || torrent.downloadUrl)) {
                    torrents.push(torrent)
                }
            } catch (_) {
                // Ignore malformed entries without failing the entire search.
            }
        }

        return torrents
    }

    async resolveMedia(media, query) {
        const searchTitle = this.cleanQuery(query)
        if (!searchTitle) return null

        const data = await this.apiGet("/media/search", {
            query: searchTitle,
            limit: 10,
        })
        const results = data && Array.isArray(data.results) ? data.results : []
        const expectedTitles = this.getMediaTitles(media)

        if (expectedTitles.length === 0) {
            expectedTitles.push(searchTitle)
        }

        const expectedYear = this.toPositiveInteger(media && media.startDate && media.startDate.year, 0)
        const exactMatches = []

        for (let i = 0; i < results.length; i++) {
            const candidate = results[i]
            if (!candidate || !candidate.id) continue

            const candidateTitles = [candidate.title].concat(
                Array.isArray(candidate.alternate_titles) ? candidate.alternate_titles : []
            )

            if (this.hasExactTitleMatch(expectedTitles, candidateTitles)) {
                exactMatches.push(candidate)
            }
        }

        if (exactMatches.length === 0) return null

        if (expectedYear) {
            for (let i = 0; i < exactMatches.length; i++) {
                if (this.toPositiveInteger(exactMatches[i].year, 0) === expectedYear) {
                    return exactMatches[i]
                }
            }
        }

        // NekoBT can aggregate multiple seasons under the first season's year.
        return exactMatches[0]
    }

    async apiGet(path, params) {
        if (!await this.ensureAuthenticated()) return null

        const query = []
        const values = params || {}
        const keys = Object.keys(values)

        for (let i = 0; i < keys.length; i++) {
            const key = keys[i]
            const value = values[key]
            if (value === undefined || value === null || value === "") continue

            query.push(encodeURIComponent(key) + "=" + encodeURIComponent(String(value)))
        }

        const url = this.apiBaseUrl + path + (query.length ? "?" + query.join("&") : "")

        try {
            const response = await fetch(url, {
                headers: {
                    Accept: "application/json",
                    Cookie: "ssid=" + NEKOBT_API_KEY,
                },
                timeout: 30,
            })

            if (!response.ok) return null

            const payload = await response.json()
            if (!payload || payload.error || !payload.data) return null

            return payload.data
        } catch (_) {
            return null
        }
    }

    async ensureAuthenticated() {
        if (this.authenticated !== null) return this.authenticated

        if (!NEKOBT_API_KEY || NEKOBT_API_KEY === "COLOQUE_A_CHAVE_AQUI") {
            this.authenticated = false
            return false
        }

        try {
            const response = await fetch(this.apiBaseUrl + "/users/@me", {
                headers: {
                    Accept: "application/json",
                    Cookie: "ssid=" + NEKOBT_API_KEY,
                },
                timeout: 30,
            })

            if (!response.ok) {
                this.authenticated = false
                return false
            }

            const payload = await response.json()
            this.authenticated = Boolean(payload && !payload.error && payload.data && payload.data.id)
            return this.authenticated
        } catch (_) {
            this.authenticated = false
            return false
        }
    }

    mapNekoTorrent(item, context) {
        if (!item || !item.id) return null

        const id = String(item.id)
        const name = String(item.title || "").trim()
        const magnet = String(item.private_magnet || item.magnet || "")
        const infoHash = String(item.infohash || this.parseInfoHash(magnet))
        const episodeIds = Array.isArray(item.media_episode_ids)
            ? item.media_episode_ids.map(value => String(value))
            : []
        const structuredEpisode = this.getStructuredEpisode(episodeIds, context && context.episodesById)
        const isBatch = item.batch === true || episodeIds.length > 1
        const mediaMatches = !context.mediaId || String(item.media_id || "") === context.mediaId
        const episodeMatches = !context.selectedEpisodeId ||
            episodeIds.indexOf(context.selectedEpisodeId) !== -1 ||
            context.episodeFilterApplied === true
        const parsedEpisode = this.parseEpisode(name)
        const parsedSeason = this.parseSeason(name)
        const seasonEpisodeMatches = context.requestedSeason > 0 &&
            parsedSeason === context.requestedSeason &&
            parsedEpisode === context.requestedEpisode
        const episodeNumber = structuredEpisode > 0
            ? structuredEpisode
            : episodeMatches && context.episodeFilterApplied
                ? context.requestedAbsoluteEpisode
                : seasonEpisodeMatches
                    ? context.requestedAbsoluteEpisode
                    : parsedEpisode

        return {
            name: name,
            date: this.toRFC3339Milliseconds(item.uploaded_at),
            size: this.toNonNegativeInteger(item.filesize),
            formattedSize: "",
            seeders: this.toNonNegativeInteger(item.seeders),
            leechers: this.toNonNegativeInteger(item.leechers),
            downloadCount: this.toNonNegativeInteger(item.completed),
            link: this.baseUrl + "/torrents/" + encodeURIComponent(id),
            downloadUrl: this.apiBaseUrl + "/torrents/" + encodeURIComponent(id) + "/download?public=true",
            magnetLink: magnet,
            infoHash: infoHash,
            resolution: this.parseResolution(name),
            isBatch: isBatch,
            episodeNumber: episodeNumber > 0 ? episodeNumber : -1,
            releaseGroup: this.getReleaseGroup(item, name),
            isBestRelease: false,
            confirmed: Boolean(context.confirmed && mediaMatches && episodeMatches),
        }
    }

    buildSmartQuery(query, opts) {
        let value = this.cleanQuery(query)

        if (opts && opts.batch) {
            value += " batch"
        } else if (opts && opts.episodeNumber > 0) {
            value += " " + String(opts.episodeNumber)
        }

        const resolution = this.normalizeResolution(opts && opts.resolution)
        if (resolution) value += " " + resolution

        return value.trim()
    }

    getBestTitle(media) {
        if (!media) return ""

        return this.cleanQuery(
            media.romajiTitle ||
            media.englishTitle ||
            (Array.isArray(media.synonyms) ? media.synonyms[0] : "") ||
            ""
        )
    }

    getMediaTitles(media) {
        if (!media) return []

        const values = [media.romajiTitle, media.englishTitle].concat(
            Array.isArray(media.synonyms) ? media.synonyms : []
        )
        const titles = []

        for (let i = 0; i < values.length; i++) {
            const title = String(values[i] || "").trim()
            if (title && titles.indexOf(title) === -1) titles.push(title)
        }

        return titles
    }

    hasExactTitleMatch(expectedTitles, candidateTitles) {
        for (let i = 0; i < expectedTitles.length; i++) {
            const expected = this.normalizeTitle(expectedTitles[i])
            if (!expected) continue

            for (let j = 0; j < candidateTitles.length; j++) {
                if (expected === this.normalizeTitle(candidateTitles[j])) return true
            }
        }

        return false
    }

    normalizeTitle(value) {
        return String(value || "")
            .toLowerCase()
            .replace(/[\s._-]+/g, " ")
            .replace(/[()[\]{}:!?,"']/g, " ")
            .replace(/\s+/g, " ")
            .trim()
    }

    cleanQuery(value) {
        return String(value || "")
            .replace(/[\r\n\t]+/g, " ")
            .replace(/\s+/g, " ")
            .trim()
    }

    findEpisode(episodes, requestedEpisode, absoluteSeasonOffset) {
        const absoluteEpisode = this.getAbsoluteEpisode(requestedEpisode, absoluteSeasonOffset)
        const absoluteMatches = episodes.filter(episode =>
            this.toPositiveInteger(episode && episode.absolute, -1) === absoluteEpisode
        )

        if (absoluteMatches.length === 1 && absoluteMatches[0].id !== undefined) {
            return absoluteMatches[0]
        }

        const localMatches = episodes.filter(episode =>
            this.toPositiveInteger(episode && episode.episode, -1) === requestedEpisode
        )

        if (localMatches.length === 1 && localMatches[0].id !== undefined) {
            return localMatches[0]
        }

        return null
    }

    getAbsoluteEpisode(episodeNumber, absoluteSeasonOffset) {
        const episode = this.toPositiveInteger(episodeNumber, -1)
        if (episode < 1) return -1

        const offset = this.toPositiveInteger(absoluteSeasonOffset, 0)
        return episode + offset
    }

    indexEpisodes(episodes) {
        const indexed = {}

        for (let i = 0; i < episodes.length; i++) {
            const episode = episodes[i]
            if (episode && episode.id !== undefined) {
                indexed[String(episode.id)] = episode
            }
        }

        return indexed
    }

    getStructuredEpisode(episodeIds, episodesById) {
        if (episodeIds.length !== 1 || !episodesById) return -1

        const episode = episodesById[episodeIds[0]]
        if (!episode) return -1

        const absolute = this.toPositiveInteger(episode.absolute, -1)
        if (absolute > 0) return absolute

        return this.toPositiveInteger(episode.episode, -1)
    }

    getReleaseGroup(item, name) {
        const groups = Array.isArray(item && item.groups) ? item.groups : []

        for (let i = 0; i < groups.length; i++) {
            const group = groups[i]
            if (group && group.uploading_group) {
                return String(group.display_name || group.name || "")
            }
        }

        return this.parseReleaseGroup(name)
    }

    sortTorrents(torrents, context) {
        const requestedResolution = context.requestedResolution || ""
        const requestedEpisode = context.requestedEpisode || -1
        const requestedAbsolute = context.requestedAbsoluteEpisode || -1

        return torrents.sort((a, b) => {
            const confirmedDifference = Number(Boolean(b.confirmed)) - Number(Boolean(a.confirmed))
            if (confirmedDifference) return confirmedDifference

            const aEpisodeMatch = a.episodeNumber === requestedEpisode || a.episodeNumber === requestedAbsolute
            const bEpisodeMatch = b.episodeNumber === requestedEpisode || b.episodeNumber === requestedAbsolute
            const episodeDifference = Number(bEpisodeMatch) - Number(aEpisodeMatch)
            if (episodeDifference) return episodeDifference

            const resolutionDifference = Number(b.resolution === requestedResolution) - Number(a.resolution === requestedResolution)
            if (resolutionDifference) return resolutionDifference

            const seederDifference = b.seeders - a.seeders
            if (seederDifference) return seederDifference

            return new Date(b.date).getTime() - new Date(a.date).getTime()
        })
    }

    normalizeResolution(value) {
        const match = String(value || "").match(/(2160|1440|1080|720|576|540|480)p?/i)
        return match ? match[1] + "p" : ""
    }

    parseInfoHash(magnet) {
        const match = String(magnet || "").match(/btih:([A-Fa-f0-9]{32,40})/i)
        return match ? match[1] : ""
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

        const seasonEpisode = text.match(
            /(?:^|[\s[\]()._-])S\d{1,2}[\s._-]?E(\d{1,4})(?:$|[\s[\]()._-])/i
        )
        if (seasonEpisode) return Number(seasonEpisode[1])

        const explicit = text.match(
            /(?:^|[\s[\]()._-])(?:E|EP|Episode)[\s._-]?(\d{1,4})(?:$|[\s[\]()._-])/i
        )
        if (explicit) return Number(explicit[1])

        const dashed = text.match(/\s-\s(\d{1,4})(?:\s|$|[\[\]()._-])/)
        if (dashed) return Number(dashed[1])

        return -1
    }

    parseSeason(name) {
        const match = String(name || "").match(
            /(?:^|[\s[\]()._-])S(\d{1,2})[\s._-]?E\d{1,4}(?:$|[\s[\]()._-])/i
        )

        return match ? Number(match[1]) : -1
    }

    parseReleaseGroup(name) {
        const match = String(name || "").match(/^\[([^\]]+)]/)
        return match ? match[1] : ""
    }

    toNonNegativeInteger(value) {
        const number = Number(value)
        if (!Number.isFinite(number) || number < 0) return 0
        return Math.floor(number)
    }

    toPositiveInteger(value, fallback) {
        const number = Number(value)
        if (!Number.isFinite(number) || number < 1) return fallback
        return Math.floor(number)
    }

    toRFC3339Milliseconds(value) {
        const milliseconds = Number(value)
        if (!Number.isFinite(milliseconds) || milliseconds < 0) {
            return new Date(0).toISOString()
        }

        const date = new Date(milliseconds)
        return Number.isNaN(date.getTime()) ? new Date(0).toISOString() : date.toISOString()
    }
}
