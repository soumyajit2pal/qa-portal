import pytest
from pydantic import ValidationError

from app import schemas


@pytest.mark.parametrize(
    "repository_url",
    [
        "https://git.example.com/team/repository.git",
        "http://git.example.com/team/repository.git",
        "ssh://git@git.example.com/team/repository.git",
        "git://git.example.com/team/repository.git",
        "git@git.example.com:team/repository.git",
    ],
)
def test_sast_repository_accepts_git_clone_urls(repository_url):
    component = schemas.SASTComponentIn(repository_url=f"  {repository_url}  ")

    assert component.repository_url == repository_url


@pytest.mark.parametrize(
    "repository_url",
    [
        "https://git.example.com/team/repository",
        "https://git.example.com/team/repository.zip",
        "repository.git",
        "file:///tmp/repository.git",
        "https://git.example.com/team/repository.git?ref=main",
        "not a git URL.git",
    ],
)
def test_sast_repository_rejects_non_git_clone_urls(repository_url):
    with pytest.raises(ValidationError, match=r"Git clone URL ending in \.git"):
        schemas.SASTComponentIn(repository_url=repository_url)


def test_blank_repository_remains_valid_for_unrelated_qa_drafts():
    assert schemas.SASTComponentIn(repository_url="").repository_url == ""


def test_sast_update_rejects_blank_repository_url():
    with pytest.raises(ValidationError, match=r"URL is required.*ending in \.git"):
        schemas.SASTUpdate(components=[schemas.SASTComponentIn(repository_url="")])
