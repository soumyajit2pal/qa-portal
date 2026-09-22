import React, { useEffect, useMemo, useState } from 'react'
import { useAuth } from '../context/AuthContext'
import { TestProjectOut } from '../types'
import { readFavoriteProjectIds, rememberFavoriteProjectIds, rememberLastProjectId } from '../projectPreferences'
import SearchableSelect from './SearchableSelect'
import { IconStar } from './Icons'

interface ProjectSelectProps {
  projects: TestProjectOut[]
  value: number | ''
  onChange: (value: number | '') => void
  placeholder?: string
  includeStatus?: boolean
  style?: React.CSSProperties
}

export default function ProjectSelect({ projects, value, onChange, placeholder, includeStatus = true, style }: ProjectSelectProps) {
  const { user } = useAuth()
  const userId = user?.id
  const [favorites, setFavorites] = useState<Set<number>>(() => readFavoriteProjectIds(userId))

  useEffect(() => {
    setFavorites(readFavoriteProjectIds(userId))
  }, [userId])

  const favoriteValues = useMemo(
    () => new Set([...favorites].filter((id) => projects.some((project) => project.id === id)).map(String)),
    [favorites, projects],
  )

  function toggleCurrentFavorite() {
    if (!value) return
    setFavorites((current) => {
      const next = new Set(current)
      if (next.has(value)) next.delete(value)
      else next.add(value)
      rememberFavoriteProjectIds(next, userId)
      return next
    })
  }

  function selectProject(next: string) {
    const nextProjectId = next ? Number(next) : ''
    if (nextProjectId) rememberLastProjectId(nextProjectId, userId)
    onChange(nextProjectId)
  }

  const selectedProject = value ? projects.find((project) => project.id === value) : undefined
  const selectedIsFavorite = Boolean(value && favorites.has(value))

  return (
    <div className="project-select-control" style={style}>
      <SearchableSelect
        value={value === '' ? '' : String(value)}
        onChange={selectProject}
        placeholder={placeholder || (projects.length ? 'Select a project...' : 'No Test Projects yet')}
        ariaLabel="Select Test Project"
        searchPlaceholder={`Search ${projects.length} project${projects.length === 1 ? '' : 's'}...`}
        favoriteValues={favoriteValues}
        favoriteGroupLabel="Favorite projects"
        optionsGroupLabel={favoriteValues.size ? 'Other projects' : 'All projects'}
        options={projects.map((project) => ({
          value: String(project.id),
          label: `${project.project_key} -- ${project.name}${includeStatus && !project.is_active ? ' [Inactive]' : ''}`,
        }))}
      />
      <button
        type="button"
        className={`project-select-favorite-toggle ${selectedIsFavorite ? 'active' : ''}`}
        disabled={!selectedProject}
        aria-pressed={selectedIsFavorite}
        aria-label={selectedProject ? `${selectedIsFavorite ? 'Remove' : 'Add'} ${selectedProject.name} ${selectedIsFavorite ? 'from' : 'to'} favorites` : 'Select a project before adding it to favorites'}
        title={selectedProject ? `${selectedIsFavorite ? 'Remove from' : 'Add to'} favorites` : 'Select a project first'}
        onClick={toggleCurrentFavorite}
      >
        <IconStar aria-hidden="true" />
      </button>
    </div>
  )
}
